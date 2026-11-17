import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { copyRuntime, copySkill } from './package-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clients = ['codex', 'claude-code', 'workbuddy'];
const json = (filename, value) => writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);

async function codexHookFiles(sourceRoot) {
  const directory = path.join(sourceRoot, 'hooks'), details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Codex hook directory must be a regular directory');
  const files = {};
  for (const name of ['hooks.json', 'capture-prompt.mjs', 'lifecycle.mjs']) {
    const filename = path.join(directory, name), entry = await lstat(filename);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Codex hook files must be regular files');
    files[name] = await readFile(filename);
  }
  const definition = JSON.parse(files['hooks.json'].toString('utf8'));
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    const groups = definition?.hooks?.[event];
    if (!Array.isArray(groups) || !groups.length || groups.some(group => !Array.isArray(group?.hooks))) throw new Error(`Codex ${event} hook definition is missing`);
    const handlers = groups.flatMap(group => group.hooks);
    if (handlers.length !== 2 || handlers.some(handler => handler?.type !== 'command' || typeof handler.command !== 'string' || !handler.command.trim())) throw new Error(`Codex ${event} requires two command hooks`);
    if (handlers.some(handler => typeof handler.commandWindows !== 'string' || !handler.commandWindows.trim()
      || typeof handler.statusMessage !== 'string' || !handler.statusMessage.trim())) throw new Error(`Codex ${event} command hooks require Windows commands and status messages`);
  }
  return files;
}

export async function buildPlugin({ sourceRoot = root, destination = path.join(root, 'artifacts', 'memoryui-plugins'), includeCodexHooks = true } = {}) {
  if (typeof includeCodexHooks !== 'boolean') throw new Error('includeCodexHooks must be a boolean');
  const hookFiles = includeCodexHooks ? await codexHookFiles(sourceRoot) : null;
  const output = path.resolve(destination);
  await readFile(path.join(sourceRoot, 'mcp.mjs'), 'utf8');
  // Never recursively replace an existing directory or mix private files into a
  // release. A caller can choose a new destination for each version.
  await mkdir(output);
  const outputs = [];
  const packageJson = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  for (const client of clients) {
    const folder = path.join(output, client);
    const skillRoot = path.join(folder, 'skills', 'memoryui');
    await mkdir(skillRoot, { recursive: true });
    await copySkill(path.join(sourceRoot, 'skills', 'memoryui'), skillRoot);
    await copySkill(path.join(sourceRoot, 'skills', 'setup'), path.join(folder, 'skills', 'setup'));
    await copyRuntime(sourceRoot, path.join(skillRoot, '.runtime'));
    await json(path.join(skillRoot, 'runtime.json'), { schemaVersion: 2, product: 'memoryui', runtimeRoot: '.runtime', clientId: client, binding: 'local' });
    const manifest = { name: 'memoryui', version: packageJson.version, description: 'Shared personal memory with a visual profile and guided local setup.', author: { name: 'MemoryUI' } };
    if (client === 'codex') {
      const extension = { onboardingSkill: './skills/setup/SKILL.md', requires_local_executor: true };
      const args = ['${PLUGIN_ROOT}/skills/memoryui/.runtime/mcp.mjs', '--client', client, '--runtime', '${PLUGIN_ROOT}/skills/memoryui/runtime.json'];
      if (hookFiles) {
        await mkdir(path.join(folder, 'hooks'));
        for (const [name, contents] of Object.entries(hookFiles)) await writeFile(path.join(folder, 'hooks', name), contents);
        // Current Codex skips lifecycle hooks for an Agent Plugins root
        // manifest (openai/codex#39895). Use its native entry point for the
        // enhanced local package; the public hook-free package stays portable.
        await mkdir(path.join(folder, '.codex-plugin'));
        await json(path.join(folder, '.codex-plugin', 'plugin.json'), {
          ...manifest, skills: './skills/', hooks: './hooks/hooks.json',
          mcpServers: './.mcp.json', requires_local_executor: true,
          extensions: { 'com.openai': { onboardingSkill: extension.onboardingSkill } }
        });
        await json(path.join(folder, '.mcp.json'), { mcpServers: { memoryui: { command: 'node', args, cwd: '${PLUGIN_ROOT}' } } });
      } else {
        await json(path.join(folder, 'plugin.json'), { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', ...manifest, extensions: { 'com.openai': extension } });
        await json(path.join(folder, 'mcp.json'), { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { memoryui: { type: 'stdio', command: 'node', args, cwd: '${PLUGIN_ROOT}' } } });
      }
    } else if (client === 'claude-code') {
      await mkdir(path.join(folder, '.claude-plugin'));
      await json(path.join(folder, '.claude-plugin', 'plugin.json'), manifest);
      await json(path.join(folder, '.mcp.json'), { mcpServers: { memoryui: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/skills/memoryui/.runtime/mcp.mjs', '--client', client, '--runtime', '${CLAUDE_PLUGIN_ROOT}/skills/memoryui/runtime.json'] } } });
    } else {
      // WorkBuddy can discover the standalone skill. This is a connector
      // example, not a claim that a platform-specific plugin was published.
      await json(path.join(folder, 'mcp.example.json'), { mcpServers: { memoryui: { command: 'node', args: ['<installed-memoryui-skill>/.runtime/mcp.mjs', '--client', client, '--runtime', '<installed-memoryui-skill>/runtime.json'] } } });
    }
    const install = client === 'codex'
      ? `将此目录作为本地插件导入 Codex，运行插件的 Setup。明确选择来源、历史日期和工作区、主题与后续记录后，后台按实际来源建立40字段资料，未知留空。${hookFiles ? '本机增强包包含 SessionStart、UserPromptSubmit、Stop 三类命令 Hook；需要在 Codex 平台审阅并信任当前 Hook 定义，且明确授权后续用户消息与开启自动记录，才会将新原话排队整理。召回继续遵守当前客户端的读取授权。未信任前继续按需记录；安装不会自动信任或修改全局 Hook。含 Hook 的包用于手动 Codex 桌面分发，不能直接作为当前公共目录提交包。' : '此包不含生命周期 Hook，自然对话按需记录依赖宿主调用技能。'}此包尚未发布到公共插件目录。`
      : client === 'claude-code'
        ? '使用 Claude Code 的本地插件加载入口加载此目录，然后执行 MemoryUI setup。'
        : '将 skills/memoryui 复制到 WorkBuddy 的技能目录（代码开发兼容目录为 ~/.codebuddy/skills/memoryui），然后说“启用我的记忆”。MCP 配置示例需要将 <installed-memoryui-skill> 替换为实际技能目录；未宣称已完成平台市场发布。';
    await writeFile(path.join(folder, 'INSTALL.md'), `# MemoryUI\n\n${install}\n\n需要 Node.js 20 或更新版本。运行文件已包含，无需原开发项目或 npm install。资料只保存在本机应用数据目录；首次无绑定使用 MemoryUI/default-vault，已有正式安装可复用 local-binding.json 中的原资料库。安装不会授予读取记忆权限；Setup 只在用户明确同意后启用所选主题。此包不包含远程账号、OAuth 服务或跨平台后台监听。\n`);
    outputs.push({ client, directory: folder });
  }
  return { destination: output, outputs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--destination')) throw new Error('用法：node scripts/build-plugin.mjs [--destination <new-directory>]');
    const destination = args[1] ? path.resolve(args[1]) : path.join(root, 'artifacts', `memoryui-plugins-${Date.now()}`);
    await mkdir(path.dirname(destination), { recursive: true });
    console.log(JSON.stringify(await buildPlugin({ destination }), null, 2));
  } catch (error) { console.error(JSON.stringify({ error: 'BUILD_FAILED', message: error.message })); process.exitCode = 1; }
}
