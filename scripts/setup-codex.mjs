import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { buildPlugin } from './build-plugin.mjs';
import { defaultVaultBinding, localBindingFile, readLocalBinding, validateBinding } from '../src/runtime-config.mjs';
import { getWorkspaceId } from '../src/server-storage.mjs';
import { findCodexExecutable } from '../src/codex-app-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const pluginId = 'memoryui@memoryui-local';
const usage = 'node scripts/setup-codex.mjs [--source <source-root>] [--codex <absolute-executable>] [--codex-home <directory> --data-dir <directory> --port <1024..65535>]';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const samePath = (left, right) => {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
};
const overlaps = (left, right) => {
  const a = path.resolve(left), b = path.resolve(right);
  return samePath(a, b) || [path.relative(a, b), path.relative(b, a)].some(value => value && value !== '..' && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value));
};
const optional = async filename => readFile(filename).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
const json = value => `${JSON.stringify(value, null, 2)}\n`;

export function parseSetupArguments(args) {
  const options = {}, names = { '--source': 'sourceRoot', '--codex': 'codexExecutable', '--codex-home': 'codexHome', '--data-dir': 'dataDirectory', '--port': 'port' };
  if (args.length % 2) fail('INVALID_ARGUMENTS', usage);
  for (let index = 0; index < args.length; index += 2) {
    const name = names[args[index]], value = args[index + 1];
    if (!name || Object.hasOwn(options, name) || !value || value.startsWith('--')) fail('INVALID_ARGUMENTS', usage);
    if (name === 'port' && !/^\d+$/.test(value)) fail('INVALID_ARGUMENTS', '端口必须是 1024 至 65535 的整数。');
    options[name] = name === 'port' ? Number(value) : value;
  }
  return options;
}

async function runCodex(executable, args, env) {
  try {
    const { stdout } = await exec(executable, args, { env, shell: false, windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    return args.includes('--json') ? JSON.parse(stdout) : stdout.trim();
  } catch { fail('CODEX_COMMAND_FAILED', 'Codex 插件命令未完成。请确认已安装当前 Codex，或使用 --codex 指定程序。'); }
}

async function checkPort(binding) {
  const occupied = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', error => error.code === 'EADDRINUSE' ? resolve(true)
      : reject(Object.assign(new Error('指定端口不可用，安装尚未修改任何配置。'), { code: 'PORT_CONFLICT' })));
    server.listen({ port: binding.servicePort, host: '127.0.0.1', exclusive: true }, () => server.close(error => error ? reject(error) : resolve(false)));
  });
  if (!occupied) return false;
  try {
    // A repeated setup may find its existing service. Check only public health
    // metadata; never stop it, replace it or request personal/context records.
    const response = await fetch(`http://127.0.0.1:${binding.servicePort}/api/health`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error('Service is not ready');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 16384) throw new Error('Health response exceeds the limit');
      chunks.push(Buffer.from(chunk));
    }
    const health = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (health.app === 'memoryui' && health.protocolVersion === 1 && health.workspaceId === binding.workspaceId && health.status === 'ready') return true;
  } catch { /* An unverified listener cannot be adopted by the installer. */ }
  fail('PORT_CONFLICT', '指定端口上的服务与目标 MemoryUI 资料库不匹配或尚未就绪，安装尚未修改任何配置。');
}

async function tree(directory, prefix = '') {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name), relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) fail('RELEASE_CONFLICT', '发布目录中存在链接，安装未覆盖。');
    if (entry.isDirectory()) Object.assign(files, await tree(filename, relative));
    else if (entry.isFile()) files[relative] = createHash('sha256').update(await readFile(filename)).digest('hex');
    else fail('RELEASE_CONFLICT', '发布目录必须只包含普通文件。');
  }
  return files;
}

export async function setupCodex(options = {}, { env = process.env, run = runCodex, build = buildPlugin } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 20) fail('NODE_REQUIRED', '需要系统已安装 Node.js 20 或更新版本。');
  const sourceRoot = path.resolve(options.sourceRoot || root);
  const explicit = ['codexHome', 'dataDirectory', 'port'].filter(key => options[key] !== undefined);
  if (explicit.length && explicit.length !== 3) fail('ISOLATION_ARGUMENTS_REQUIRED', '--codex-home、--data-dir、--port 必须一起显式提供。');
  const isolated = explicit.length === 3;
  for (const key of ['codexHome', 'dataDirectory']) if (options[key] !== undefined && !path.isAbsolute(options[key])) fail('INVALID_ARGUMENTS', '隔离目录必须使用绝对路径。');
  if (isolated && (!Number.isSafeInteger(options.port) || options.port < 1024 || options.port > 65535)) fail('INVALID_ARGUMENTS', '端口必须是 1024 至 65535 的整数。');
  const codexHome = path.resolve(options.codexHome || env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const marketplace = path.join(codexHome, '.memoryui', 'marketplaces', 'memoryui-local');
  const catalogFile = path.join(marketplace, '.agents', 'plugins', 'marketplace.json');
  const bindingFile = localBindingFile(env), bindingBefore = await optional(bindingFile);
  const registered = readLocalBinding(env), localBinding = registered || defaultVaultBinding(env);
  if (isolated && (overlaps(codexHome, path.join(os.homedir(), '.codex')) || overlaps(options.dataDirectory, localBinding.dataDirectory)
    || options.port === localBinding.servicePort)) fail('ISOLATION_CONFLICT', '隔离参数与正式 Codex、资料库或服务端口重叠，安装尚未修改任何配置。');
  const binding = isolated ? validateBinding({ dataDirectory: options.dataDirectory, workspaceId: getWorkspaceId(options.dataDirectory), servicePort: options.port }) : localBinding;
  if (overlaps(sourceRoot, marketplace) || overlaps(sourceRoot, binding.dataDirectory) || overlaps(marketplace, binding.dataDirectory)) fail('DIRECTORY_CONFLICT', '源码、插件发布目录与资料库必须分开。');
  const sourceInfo = await lstat(sourceRoot);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) fail('INVALID_SOURCE', '源码必须是普通目录。');
  const pkg = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  if (pkg.name !== 'memoryui' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) fail('INVALID_SOURCE', '未找到有效的 MemoryUI 源码版本。');
  const catalogBefore = await optional(catalogFile);
  const catalog = catalogBefore ? JSON.parse(catalogBefore) : { name: 'memoryui-local', interface: { displayName: 'MemoryUI 本机' }, plugins: [] };
  if (catalog.name !== 'memoryui-local' || !Array.isArray(catalog.plugins) || catalog.plugins.filter(item => item.name === 'memoryui').length > 1) fail('MARKETPLACE_CONFLICT', '本机 marketplace 目录已属于不同配置，安装未覆盖。');
  const existingServiceKept = isolated ? await checkPort(binding) : false;
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'CODEX_HOME') delete childEnv[key];
  childEnv.CODEX_HOME = codexHome;
  let executable = options.codexExecutable;
  if (executable && (!path.isAbsolute(executable) || !(await lstat(executable)).isFile())) fail('CODEX_UNAVAILABLE', '--codex 必须指向现有可执行文件的绝对路径。');
  if (!executable) {
    executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
    try { await run(executable, ['--version'], childEnv); }
    catch { executable = await findCodexExecutable(env); await run(executable, ['--version'], childEnv); }
  } else await run(executable, ['--version'], childEnv);
  const sources = await run(executable, ['plugin', 'marketplace', 'list', '--json'], childEnv);
  if (!Array.isArray(sources?.marketplaces)) fail('INVALID_CODEX_RESPONSE', 'Codex 未返回可核对的 marketplace 列表。');
  const existing = sources.marketplaces.find(item => item.name === 'memoryui-local');
  if (existing && (typeof existing.root !== 'string' || !samePath(existing.root.replace(/^\\\\\?\\/, ''), marketplace))) fail('MARKETPLACE_CONFLICT', 'Codex 中同名 marketplace 指向其他目录，安装未覆盖。');

  const stageRoot = path.join(codexHome, '.memoryui', 'setup-staging');
  const stage = path.join(stageRoot, randomUUID());
  const release = path.join(marketplace, 'releases', pkg.version);
  let reused = false;
  try {
    await mkdir(stageRoot, { recursive: true });
    await build({ sourceRoot, destination: stage });
    const runtimeFile = path.join(stage, 'codex', 'skills', 'memoryui', 'runtime.json');
    if (isolated) await writeFile(runtimeFile, json({ schemaVersion: 2, product: 'memoryui', runtimeRoot: '.runtime', clientId: 'codex', binding: 'explicit', ...binding }), { mode: 0o600 });
    const oldRelease = await lstat(release).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (oldRelease) {
      if (!oldRelease.isDirectory() || oldRelease.isSymbolicLink()) fail('RELEASE_CONFLICT', '同版本发布目标不是普通目录，安装未覆盖。');
      const [wanted, previous] = await Promise.all([tree(path.join(stage, 'codex')), tree(path.join(release, 'codex'))]);
      if (JSON.stringify(Object.entries(wanted).sort()) !== JSON.stringify(Object.entries(previous).sort())) fail('RELEASE_CONFLICT', '同版本发布内容或资料绑定不同；请使用新的软件版本，安装未覆盖。');
      reused = true;
    } else {
      await mkdir(path.dirname(release), { recursive: true });
      await rename(stage, release);
    }
    const currentCatalog = await optional(catalogFile);
    if (String(currentCatalog) !== String(catalogBefore)) fail('MARKETPLACE_CHANGED', '安装期间 marketplace 配置已变化，未覆盖其他进程的修改。');
    const entry = catalog.plugins.find(item => item.name === 'memoryui');
    if (entry) entry.source = { source: 'local', path: `./releases/${pkg.version}/codex` };
    else catalog.plugins.push({ name: 'memoryui', source: { source: 'local', path: `./releases/${pkg.version}/codex` }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' });
    await mkdir(path.dirname(catalogFile), { recursive: true });
    const temporaryCatalog = `${catalogFile}.${randomUUID()}.tmp`;
    await writeFile(temporaryCatalog, json(catalog), { flag: 'wx' });
    await rename(temporaryCatalog, catalogFile);
    if (!existing) await run(executable, ['plugin', 'marketplace', 'add', marketplace, '--json'], childEnv);
    await run(executable, ['plugin', 'add', pluginId, '--json'], childEnv);
    const result = await run(executable, ['plugin', 'list', '--marketplace', 'memoryui-local', '--json'], childEnv);
    const installed = result?.installed?.find(item => item.pluginId === pluginId);
    if (!installed?.installed || installed.enabled !== true || installed.version !== pkg.version) fail('INSTALL_UNCONFIRMED', 'Codex 尚未确认目标版本已安装并启用，请查看插件设置。');
    const installedPath = path.join(codexHome, 'plugins', 'cache', 'memoryui-local', 'memoryui', pkg.version);
    const runnerPath = path.join(installedPath, 'skills', 'memoryui', 'scripts', 'run.mjs');
    const payload = await tree(path.join(release, 'codex'));
    for (const [relative, hash] of Object.entries(payload)) {
      const actual = createHash('sha256').update(await readFile(path.join(installedPath, relative))).digest('hex');
      if (actual !== hash) fail('INSTALL_UNCONFIRMED', '已安装缓存与本次发布内容不同，未确认安装成功。');
    }
    if (!(await lstat(runnerPath)).isFile()) fail('INSTALL_UNCONFIRMED', '已安装插件缺少同绑定运行入口。');
    if (String(await optional(bindingFile)) !== String(bindingBefore)) fail('BINDING_CHANGED', '正式资料绑定在安装期间发生变化，请核对后再继续。');
    return { installed: true, version: pkg.version, plugin_id: pluginId, codex_home: codexHome, marketplace, release: path.join(release, 'codex'),
      installedPath, runnerPath,
      data_directory: binding.dataDirectory, port: binding.servicePort, isolated, reused_release: reused, existing_service_kept: existingServiceKept,
      restart_required: true, trust_required: true, trust_checked: false, runtime: 'system-node', node_version: process.versions.node,
      notice: '本机插件已安装；重新打开 Codex 后按平台提示审阅 Hook。安装未修改信任、启用资料采集或读取历史。需要系统 Node.js 20 或更新版本。' };
  } finally {
    if (!samePath(path.dirname(stage), stageRoot) || !/^[0-9a-f-]{36}$/.test(path.basename(stage))) throw new Error('Invalid managed staging path');
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') console.log(json({ usage, runtime: 'Requires installed Node.js 20+ and Codex.' }));
    else console.log(json(await setupCodex(parseSetupArguments(process.argv.slice(2)))));
  } catch (error) {
    console.error(json({ installed: false, error: error.code || 'SETUP_FAILED', message: error.message, restart_required: false, trust_required: true }));
    process.exitCode = 1;
  }
}
