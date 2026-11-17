import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, readdir, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { copyRuntime, copySkill } from './package-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function buildInstallKit({ sourceRoot = root, destination } = {}) {
  const { version } = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  const output = path.resolve(destination || path.join(sourceRoot, 'artifacts', `memoryui-codex-install-${version}-${Date.now()}`));
  await mkdir(output); // A release kit never replaces an existing folder.
  await copyRuntime(sourceRoot, output);
  for (const skill of ['memoryui', 'setup']) await copySkill(path.join(sourceRoot, 'skills', skill), path.join(output, 'skills', skill));
  await mkdir(path.join(output, 'hooks'));
  for (const name of ['hooks.json', 'capture-prompt.mjs', 'lifecycle.mjs']) await cp(path.join(sourceRoot, 'hooks', name), path.join(output, 'hooks', name));
  await mkdir(path.join(output, 'scripts'));
  for (const name of ['setup-codex.mjs', 'build-plugin.mjs', 'package-runtime.mjs', 'build-install-kit.mjs']) await cp(path.join(sourceRoot, 'scripts', name), path.join(output, 'scripts', name));
  await cp(path.join(sourceRoot, 'INSTALL.md'), path.join(output, 'INSTALL.md'));
  await mkdir(path.join(output, 'docs'));
  await cp(path.join(sourceRoot, 'docs', 'CODEX_INSTALL_ACCEPTANCE.md'), path.join(output, 'docs', 'CODEX_INSTALL_ACCEPTANCE.md'));
  await writeFile(path.join(output, 'README.md'), `# MemoryUI 安装初始化包\n\n将本目录连同 INSTALL.md 交给本机 Codex，说“请按 INSTALL.md 自动安装并加载已授权记忆”。\n\n版本 ${version}。当前需要 Node.js 20+；本包不含 Node、用户资料或平台登录信息。无需 npm install。Hook 信任仍按 Codex 平台要求完成。\n`);
  const files = {};
  async function inspect(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name), relative = path.posix.join(prefix, entry.name);
      if (entry.isSymbolicLink()) throw Error('Install kit must not contain symlinks');
      if (entry.isDirectory()) await inspect(filename, relative);
      else files[relative] = createHash('sha256').update(await readFile(filename)).digest('hex');
    }
  }
  await inspect(output);
  await writeFile(path.join(output, 'SOURCE_MANIFEST.json'), JSON.stringify({ product: 'memoryui', version, files }, null, 2) + '\n');
  return { destination: output, version, files: Object.keys(files).length, includesNodeRuntime: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--destination') throw Error('用法：node scripts/build-install-kit.mjs --destination <new-directory>');
    console.log(JSON.stringify(await buildInstallKit({ destination: args[1] }), null, 2));
  } catch (error) { console.error(JSON.stringify({ error: 'INSTALL_KIT_FAILED', message: error.message })); process.exitCode = 1; }
}
