import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const directory = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(directory, '..');
let workspaceRoot = path.resolve(skillRoot, '../..');
let clientId = 'codex';
let servicePort;
let requireSimulation = false;
let workspaceId;
let dataDirectory;
const clients = new Set(['codex', 'claude-code', 'workbuddy', 'chatgpt']);
const configFile = path.join(skillRoot, 'runtime.json');
try {
  if (existsSync(configFile)) {
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    const helperRoot = config.runtimeRoot === '.runtime' ? path.join(skillRoot, '.runtime') : config.workspaceRoot;
    if (typeof helperRoot !== 'string' || !path.isAbsolute(helperRoot)) throw new Error();
    const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(helperRoot, 'src/runtime-config.mjs')));
    const resolved = resolveRuntimeConfig(config, skillRoot);
    workspaceRoot = resolved.runtimeRoot;
    ({ clientId, servicePort, requireSimulation, workspaceId, dataDirectory } = resolved);
    if (!clients.has(clientId)) throw new Error();
  }
  const entry = path.join(workspaceRoot, 'agent.mjs');
  if (!existsSync(entry)) throw new Error();
  const args = process.argv.slice(2);
  const clientArguments = args.flatMap((arg, index) => arg === '--client' ? [index] : []);
  if (clientArguments.length > 1 || (clientArguments.length === 1 && args[clientArguments[0] + 1] !== clientId)) {
    console.error(JSON.stringify({ error: 'CLIENT_MISMATCH', message: '此技能已绑定当前客户端，不能借用另一个客户端的读取身份。' }));
    process.exitCode = 1;
  } else {
    const env = {
      ...process.env, ...(servicePort === undefined ? {} : { PORT: String(servicePort) }),
      ...(workspaceId ? { MEMORYUI_WORKSPACE_ID: workspaceId } : {}),
      ...(dataDirectory ? { MEMORYUI_DATA_DIR: dataDirectory } : {}),
      MEMORYUI_REQUIRE_SIMULATION: requireSimulation ? '1' : '0', MEMORYUI_AUTO_START: requireSimulation ? '0' : '1',
    };
    if (requireSimulation) {
      try {
        const { verifyService, serviceOptions } = await import(pathToFileURL(entry));
        const settings = serviceOptions(workspaceRoot, env);
        await verifyService(settings);
        const response = await fetch(`${settings.url}/api/state`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
        if (!response.ok || (await response.json()).simulation !== true) throw new Error();
      } catch {
        console.error(JSON.stringify({ error: 'SIMULATION_REQUIRED', message: '模拟服务不可用或不是独立模拟库。请在 MemoryUI 工作区运行 npm run simulate:panel；不会启动正式服务。' }));
        process.exit(1);
      }
    }
    if (!args.length) args.push('open');
    if (!clientArguments.length) args.push('--client', clientId);
    const result = spawnSync(process.execPath, [entry, ...args], { cwd: workspaceRoot, env, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} catch {
  console.error(JSON.stringify({ error: 'RUNTIME_NOT_FOUND', message: 'MemoryUI 安装不完整或本机资料绑定无效，请重新安装 MemoryUI。' }));
  process.exitCode = 1;
}
