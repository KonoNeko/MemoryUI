import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { getWorkspaceId, getDataDirectory } from './src/server-storage.mjs';
import { loadEnvironment } from './server.mjs';
import { MEMORY_TYPES } from './src/memory-types.js';
import { REVIEW_REASONS, isUsableMemory } from './src/memory-policy.js';
import { memoryContextView, REFERENCE_USAGE_POLICY } from './src/task-recall.mjs';
import { normalizeRecallScope } from './src/recall-scope.mjs';
import { normalizeCodexLifecycleEvent } from './src/codex-lifecycle.mjs';

export const WORKSPACE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CATEGORIES = ['关于我', '沟通偏好', '当前项目', '生活偏好'];
const WORKSPACES = ['general', 'work', 'personal', 'private'];
export const AGENT_CLIENTS = Object.freeze({ codex: 'Codex', 'claude-code': 'Claude Code', workbuddy: 'WorkBuddy', chatgpt: 'ChatGPT' });
const OPTIONS = new Set(['client', 'query', 'id', 'content', 'category', 'workspace', 'memory-type', 'review-reason', 'limit', 'budget', 'scope-file', 'source', 'excerpt', 'expected-revision', 'input-file']);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class AgentError extends Error {
  constructor(code, message) { super(message); this.name = 'AgentError'; this.code = code; }
}
const invalid = (message) => { throw new AgentError('INVALID_ARGUMENT', message); };

export function parseArguments(argv) {
  const command = argv[0] || 'open';
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const token = argv[index];
    if (!token.startsWith('--') || !OPTIONS.has(token.slice(2))) invalid(`不支持的参数：${token}`);
    const name = token.slice(2);
    if (Object.hasOwn(options, name)) invalid(`参数重复：${token}`);
    if (argv[index + 1] === undefined || argv[index + 1].startsWith('--')) invalid(`${token} 后需要提供值。`);
    options[name] = argv[index + 1];
  }
  return { command, options };
}

export function serviceOptions(root = WORKSPACE_ROOT, env = process.env) {
  const port = env.PORT === undefined ? 4173 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) invalid('PORT 必须为 1024 到 65535 之间的整数。');
  return { root: path.resolve(root), env, url: `http://127.0.0.1:${port}`, workspaceId: getWorkspaceId(root, env), requireSimulation: env.MEMORYUI_REQUIRE_SIMULATION === '1' };
}

async function requestJson(url, pathname, { fetchImpl = globalThis.fetch, method = 'GET', body, timeout = 8000, requireSimulation = false } = {}) {
  let response;
  try {
    response = await fetchImpl(`${url}${pathname}`, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(requireSimulation ? { 'X-MemoryUI-Mode': 'simulation' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout), redirect: 'error',
    });
  } catch (error) {
    const refused = error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED';
    throw new AgentError(refused ? 'SERVICE_NOT_RUNNING' : 'SERVICE_UNAVAILABLE', refused ? '记忆服务尚未启动。' : '无法访问本机记忆服务。');
  }
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) throw new AgentError('INVALID_RESPONSE', '服务响应超过大小限制。');
  let result;
  try { result = JSON.parse(text); }
  catch { throw new AgentError('INVALID_RESPONSE', '端口上的服务没有返回有效 JSON。'); }
  if (!response.ok) throw new AgentError(result.code || result.error || 'REQUEST_FAILED', result.message || `请求失败（${response.status}）。`);
  return result;
}

export async function verifyService(settings, { fetchImpl = globalThis.fetch } = {}) {
  const health = await requestJson(settings.url, '/api/health', { fetchImpl, timeout: 2000, requireSimulation: settings.requireSimulation });
  if (health.app !== 'memoryui' || health.protocolVersion !== 1 || health.workspaceId !== settings.workspaceId || health.status !== 'ready') {
    throw new AgentError('WRONG_SERVICE', '此端口属于其他服务或另一个 MemoryUI 工作区，请检查 PORT。');
  }
  if (settings.requireSimulation && health.simulation !== true) throw new AgentError('SIMULATION_REQUIRED', '此服务不是独立模拟库。');
  return health;
}

export function startBackgroundService(settings) {
  const directory = getDataDirectory(settings.root, settings.env);
  mkdirSync(directory, { recursive: true });
  const log = openSync(path.join(directory, 'service.log'), 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [path.join(settings.root, 'server.mjs')], {
      // Windows holds the process working directory open. The vault is stable
      // across installations; keeping cwd here lets the installer atomically
      // replace .runtime while this service continues serving existing data.
      // server.mjs resolves code, static assets and .env through import.meta.
      cwd: directory, env: settings.env, detached: true, windowsHide: true,
      stdio: ['ignore', log, log],
    });
    child.unref();
  } finally { closeSync(log); }
  return child;
}

export async function ensureService(settings, { fetchImpl = globalThis.fetch, startService = startBackgroundService, wait = delay } = {}) {
  try { return await verifyService(settings, { fetchImpl }); }
  catch (error) { if (error.code !== 'SERVICE_NOT_RUNNING') throw error; }
  if (settings.requireSimulation) throw new AgentError('SIMULATION_REQUIRED', '模拟服务未启动，不会启动正式服务。');
  const child = startService(settings);
  let launchError = false;
  child?.once?.('error', () => { launchError = true; });
  for (let attempt = 0; attempt < 32; attempt += 1) {
    await wait(125);
    if (launchError) throw new AgentError('START_FAILED', '无法启动本机记忆服务。');
    try { return await verifyService(settings, { fetchImpl }); }
    catch (error) { if (error.code !== 'SERVICE_NOT_RUNNING') throw error; }
  }
  throw new AgentError('START_FAILED', '记忆服务未能启动，请检查端口与服务日志。');
}

function rejectUnused(options, allowed) {
  for (const name of Object.keys(options)) if (!allowed.includes(name)) invalid(`此命令不支持 --${name}。`);
}
const nonempty = (value, label, limit = 4000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) invalid(`${label}必须是 1–${limit} 个字符的文本。`);
  return value.trim();
};
const currentMemory = memoryContextView;

function readableByClient(memory, connection, client) {
  return !!(connection?.enabled && connection.mode === 'local-agent' && isUsableMemory(memory) &&
    ((!connection.pausedLegacyGrants?.workspaces && connection.workspaces.includes(memory.workspace))
      || (!connection.pausedLegacyGrants?.newMemories && connection.setup?.readNew === true && connection.memoryIds?.includes(memory.id))
      || (connection.profileSharing?.enabled === true && connection.profileSharing.categories?.includes(memory.category)))
    && (!memory.audience.length || memory.audience.includes(client))
    && memory.source.platform.trim() !== '演示对话' && !memory.id.startsWith('demo-'));
}

async function mutationInput(options, command, clientName) {
  const { client: ignoredClient, ...payloadOptions } = options;
  options = payloadOptions;
  let input;
  if (options['input-file']) {
    rejectUnused(options, ['input-file']);
    const filename = path.resolve(options['input-file']);
    const details = await stat(filename);
    if (!details.isFile() || details.size > 65536) invalid('输入文件必须是小于 64 KiB 的 JSON 文件。');
    try { input = JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, '')); }
    catch { invalid('输入文件不是有效 JSON。'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('输入文件必须包含 JSON 对象。');
  } else {
    rejectUnused(options, command === 'propose' ? ['content', 'category', 'workspace', 'memory-type', 'review-reason', 'source', 'excerpt'] : command === 'remember' ? ['id', 'expected-revision', 'content', 'category', 'workspace', 'memory-type', 'source', 'excerpt'] : ['id', 'content', 'category', 'workspace', 'memory-type', 'review-reason', 'expected-revision']);
    input = { ...options };
    if (Object.hasOwn(input, 'memory-type')) { input.memoryType = input['memory-type']; delete input['memory-type']; }
    if (Object.hasOwn(input, 'review-reason')) { input.reviewReasons = [input['review-reason']]; delete input['review-reason']; }
    if (Object.hasOwn(input, 'expected-revision')) {
      input.expectedRevision = Number(input['expected-revision']);
      delete input['expected-revision'];
    }
  }
  const allowed = command === 'propose' ? ['content', 'category', 'workspace', 'memoryType', 'reviewReasons', 'source', 'excerpt'] : command === 'remember' ? ['id', 'expectedRevision', 'content', 'category', 'workspace', 'memoryType', 'source', 'excerpt'] : ['id', 'content', 'category', 'workspace', 'memoryType', 'reviewReasons', 'expectedRevision'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) invalid('输入包含不支持的字段。');
  if (input.content !== undefined) input.content = nonempty(input.content, '记忆内容');
  if (input.category !== undefined && !CATEGORIES.includes(input.category)) invalid('记忆类别无效。');
  if (input.workspace !== undefined && !WORKSPACES.includes(input.workspace)) invalid('记忆空间无效。');
  if (input.memoryType !== undefined && !Object.hasOwn(MEMORY_TYPES, input.memoryType)) invalid('记忆方式无效。');
  if (input.reviewReasons !== undefined && (!Array.isArray(input.reviewReasons) || input.reviewReasons.length > Object.keys(REVIEW_REASONS).length || input.reviewReasons.some(reason => typeof reason !== 'string' || !Object.hasOwn(REVIEW_REASONS, reason)) || new Set(input.reviewReasons).size !== input.reviewReasons.length)) invalid('核对理由必须是没有重复的已知理由列表。');
  if (command === 'remember') {
    const hasId = Object.hasOwn(input, 'id');
    if (hasId !== Object.hasOwn(input, 'expectedRevision')) invalid('修改指定记忆需要 id 和 expectedRevision。');
    if (hasId) {
      input.id = nonempty(input.id, '记忆编号', 100);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) invalid('修改需要 expectedRevision 正整数。');
    }
    return {
      memory: {
        content: nonempty(input.content, '记忆内容'), category: input.category ?? '关于我',
        ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
        ...(input.memoryType === undefined ? {} : { memoryType: input.memoryType }),
        source: { label: nonempty(input.source ?? `${clientName} 对话 · 本人明确陈述`, '来源名称', 300),
          excerpt: nonempty(input.excerpt, '用户陈述原文', 16000), platform: clientName, at: new Date().toISOString() },
      },
      options: hasId ? { id: input.id, expectedRevision: input.expectedRevision } : {},
    };
  }
  if (command === 'propose') {
    const content = nonempty(input.content, '记忆内容');
    return {
      content, category: input.category ?? '关于我', workspace: input.workspace ?? 'private', origin: 'inferred',
      ...(input.memoryType === undefined ? {} : { memoryType: input.memoryType }),
      ...(input.reviewReasons === undefined ? {} : { reviewReasons: input.reviewReasons }),
      source: {
        label: nonempty(input.source ?? `${clientName} 对话 · 自动整理的参考`, '来源名称', 300),
        excerpt: nonempty(input.excerpt ?? content, '来源原文', 16000), platform: clientName, at: new Date().toISOString(),
      },
    };
  }
  input.id = nonempty(input.id, '记忆编号', 100);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) invalid('修改需要 expectedRevision 正整数，请先读取当前版本。');
  if (!['content', 'category', 'workspace', 'memoryType', 'reviewReasons'].some((key) => Object.hasOwn(input, key))) invalid('修改至少需要一个内容字段。');
  return input;
}

const captureId = value => {
  if (typeof value!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid('授权任务编号必须是面板生成的 UUID。');
  return value;
};
async function captureInput(options) {
  if (!options['input-file']) invalid('capture 需要 --input-file 指向模板 JSON 文件。');
  const filename=path.resolve(options['input-file']);
  const details=await stat(filename);
  if (!details.isFile() || details.size>120*1024) invalid('批量输入必须是小于 120 KiB 的 JSON 文件。');
  let input;
  try { input=JSON.parse((await readFile(filename,'utf8')).replace(/^\uFEFF/,'')); }
  catch { invalid('批量输入文件不是有效 JSON。'); }
  if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>!['requestId','version','entries'].includes(key))) invalid('批量输入只支持 requestId、version 和 entries。');
  captureId(input.requestId);
  if (input.version!==1 || !Array.isArray(input.entries) || input.entries.length>20) invalid('模板 version 必须为 1，entries 最多 20 条。');
  const targetedIds = new Set();
  for (const item of input.entries) {
    if (!item || typeof item!=='object' || Array.isArray(item) || Object.keys(item).some(key=>!['kind','evidenceKind','content','category','memoryType','excerpt','reviewReasons','target'].includes(key))) invalid('批量条目包含不支持的字段。');
    if (!['explicit','reference'].includes(item.kind) || !['user_quote','host_summary','inference'].includes(item.evidenceKind)) invalid('条目需要明确的 kind 和 evidenceKind。');
    if (item.kind==='explicit' && (item.evidenceKind!=='user_quote' || Object.hasOwn(item,'reviewReasons'))) invalid('只有本人明确原文可以直接确认；摘要和推断请保存为参考。');
    if (Object.hasOwn(item, 'target')) {
      const target = item.target;
      if (item.kind !== 'explicit' || item.evidenceKind !== 'user_quote') invalid('只有本人明确原文可以指定要更新的记录。');
      if (!target || Object.getPrototypeOf(target) !== Object.prototype || Object.keys(target).some(key => !['id', 'expectedRevision'].includes(key))
        || !Object.hasOwn(target, 'id') || !Object.hasOwn(target, 'expectedRevision')) invalid('更新目标只支持成对的 id 和 expectedRevision。');
      nonempty(target.id, '目标记忆编号', 100);
      if (!Number.isSafeInteger(target.expectedRevision) || target.expectedRevision < 1) invalid('更新目标需要 expectedRevision 正整数。');
      if (targetedIds.has(target.id)) invalid('同一批次不能重复指定同一条目标记忆。');
      targetedIds.add(target.id);
    }
    nonempty(item.content,'记忆内容'); nonempty(item.excerpt,'来源原文');
    if (!CATEGORIES.includes(item.category)) invalid('记忆类别无效。');
    if (item.memoryType!==undefined && !Object.hasOwn(MEMORY_TYPES,item.memoryType)) invalid('记忆方式无效。');
    if (item.reviewReasons!==undefined && (!Array.isArray(item.reviewReasons) || item.reviewReasons.some(reason=>!Object.hasOwn(REVIEW_REASONS,reason)) || new Set(item.reviewReasons).size!==item.reviewReasons.length)) invalid('核对理由无效或重复。');
  }
  return input;
}

async function codexImportInput(options, start = false) {
  if (!options['input-file']) invalid('原生记忆导入需要 --input-file JSON。');
  const filename = path.resolve(options['input-file']);
  const details = await stat(filename);
  if (!details.isFile() || details.size > 120 * 1024) invalid('导入输入必须是小于 120 KiB 的 JSON 文件。');
  let input;
  try { input = JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, '')); }
  catch { invalid('导入输入不是有效 JSON。'); }
  const allowed = start ? ['consent'] : ['requestId', 'version', 'entries'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) invalid('原生导入输入含有不支持的字段。');
  if (start) {
    if (input.consent !== true) throw new AgentError('CONSENT_REQUIRED', '请先取得用户对 Codex 本机记忆导入的明确授权。');
  } else {
    captureId(input.requestId);
    if (input.version !== 1 || !Array.isArray(input.entries) || input.entries.length > 20) invalid('导入版本必须为 1，每批最多 20 条。');
    for (const item of input.entries) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['sourceId', 'content', 'category', 'excerpt', 'memoryType', 'reviewReasons'].includes(key))) invalid('导入条目字段无效，不可指定确认状态、平台或授权。');
      nonempty(item.sourceId, '来源编号', 100); nonempty(item.content, '记忆内容'); nonempty(item.excerpt, '来源原文');
      if (!CATEGORIES.includes(item.category)) invalid('记忆类别无效。');
      if (item.memoryType !== undefined && !Object.hasOwn(MEMORY_TYPES, item.memoryType)) invalid('记忆类型无效。');
      if (item.reviewReasons !== undefined && (!Array.isArray(item.reviewReasons) || new Set(item.reviewReasons).size !== item.reviewReasons.length || item.reviewReasons.some(reason => !Object.hasOwn(REVIEW_REASONS, reason)))) invalid('核对理由无效。');
    }
  }
  return input;
}

async function setupInput(filename) {
  const details = await stat(path.resolve(filename));
  if (!details.isFile() || details.size > 8192) invalid('设置文件必须是小于 8 KiB 的 JSON 文件。');
  let input;
  try { input = JSON.parse((await readFile(path.resolve(filename), 'utf8')).replace(/^\uFEFF/, '')); }
  catch { invalid('设置文件不是有效 JSON。'); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['categories', 'autoCapture', 'readNew'].includes(key))
    || !Array.isArray(input.categories) || !input.categories.length || new Set(input.categories).size !== input.categories.length || input.categories.some(category => !CATEGORIES.includes(category))
    || typeof input.autoCapture !== 'boolean' || typeof input.readNew !== 'boolean') invalid('设置需要有效的 categories、autoCapture 和 readNew，不能指定来源或身份。');
  return input;
}

async function recallScopeInput(filename) {
  nonempty(filename, '读取范围文件路径', 32768);
  if (!path.isAbsolute(filename)) invalid('读取范围需要绝对文件路径。');
  let content;
  try {
    const absolute = path.resolve(filename);
    const details = await stat(absolute);
    if (!details.isFile() || details.size > 8192) invalid('读取范围必须是最多 8 KiB 的 JSON 文件。');
    content = await readFile(absolute, 'utf8');
  } catch (error) {
    if (error instanceof AgentError) throw error;
    invalid('无法读取本次范围 JSON 文件。');
  }
  if (Buffer.byteLength(content, 'utf8') > 8192) invalid('读取范围文件超过 8 KiB。');
  let input;
  try { input = JSON.parse(content.replace(/^\uFEFF/, '')); }
  catch { invalid('读取范围文件不是有效 JSON。'); }
  try { return normalizeRecallScope(input); }
  catch { invalid('本次读取范围包含未知、重复或冲突的字段。'); }
}

export async function runCommand(argv, { root = WORKSPACE_ROOT, env = process.env, fetchImpl = globalThis.fetch, startService, wait, eventInput } = {}) {
  const { command, options } = parseArguments(argv);
  if (!['open', 'setup', 'capture-start', 'status', 'storage-status', 'list', 'search', 'show', 'context', 'recall', 'remember', 'propose', 'update', 'capture-request', 'capture', 'codex-sources', 'codex-import-start', 'codex-import-template', 'codex-import-submit', 'profile-status', 'profile-start', 'capture-event', 'capture-event-status', 'lifecycle-event', 'request-context', 'compress-conversation', 'save-project-memory'].includes(command)) invalid('不支持此记忆命令。');
  const settings = serviceOptions(root, env);
  const client = options.client ?? 'codex';
  if (!Object.hasOwn(AGENT_CLIENTS, client)) invalid('client 应为 chatgpt、workbuddy、codex 或 claude-code。');
  const clientName = AGENT_CLIENTS[client];
  const hostThreadId = client === 'codex' && typeof env.CODEX_THREAD_ID === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.CODEX_THREAD_ID) ? env.CODEX_THREAD_ID : null;
  if (['search', 'recall'].includes(command)) nonempty(options.query, '查询', 2000);
  if (command === 'recall') {
    if (options['memory-type'] !== undefined && options['memory-type'] !== 'all' && !Object.hasOwn(MEMORY_TYPES, options['memory-type'])) invalid('记忆方式无效。');
    for (const [key, minimum, maximum] of [['limit', 1, 20], ['budget', 256, 16000]]) {
      const value = options[key];
      if (value !== undefined && (!/^\d+$/.test(value) || Number(value) < minimum || Number(value) > maximum)) invalid(`${key} 必须是 ${minimum}–${maximum} 的整数。`);
    }
  }
  if (command === 'show') nonempty(options.id, '记忆编号', 100);
  const request = (pathname, details = {}) => requestJson(settings.url, pathname, { fetchImpl, requireSimulation: settings.requireSimulation, ...details });
  const connect = () => env.MEMORYUI_AUTO_START === '1' ? ensureService(settings, { fetchImpl, startService, wait }) : verifyService(settings, { fetchImpl });
  const contextCommands = { 'request-context': 'request', 'compress-conversation': 'conversations', 'save-project-memory': 'project' };
  if (Object.hasOwn(contextCommands, command)) {
    rejectUnused(options, ['client', 'input-file']);
    if (!options['input-file']) invalid('此命令需要 --input-file 指向 JSON 文件。');
    const filename = path.resolve(options['input-file']);
    const details = await stat(filename);
    if (!details.isFile() || details.size > 120 * 1024) invalid('结构化输入最多 120 KiB。');
    let input;
    try { input = JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, '')); }
    catch { invalid('输入文件不是有效 JSON。'); }
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.hasOwn(input, 'client')) invalid('输入必须是对象，客户端身份由当前绑定提供。');
    const health = await connect();
    if (health.capabilities?.contextMemory !== 1) throw new AgentError('UPGRADE_REQUIRED', '运行中的服务需要升级后才能使用对话和项目记忆。');
    return request(`/api/context-memory/${contextCommands[command]}`, { method: 'POST', body: { ...input, client } });
  }
  if (command === 'lifecycle-event') {
    if (client !== 'codex') throw new AgentError('CODEX_CLIENT_REQUIRED', '生命周期入口只供绑定的 Codex 使用。');
    rejectUnused(options, ['client']);
    if (env.MEMORYUI_CAPTURE_WORKER === '1' || env.MEMORYUI_EXTRACTION_WORKER === '1') return { accepted: false, reason: 'worker' };
    if (!eventInput || Object.getPrototypeOf(eventInput) !== Object.prototype || Object.keys(eventInput).some(key => !['action', 'event'].includes(key))) invalid('生命周期操作需要标准输入事件。');
    const event = normalizeCodexLifecycleEvent(eventInput.event), action = eventInput.action;
    if (!event) return { accepted: false, reason: 'non_user_agent' };
    if (!['check-service', 'workspace', 'save-memory'].includes(action) || action === 'check-service' && event.hook_event_name !== 'SessionStart' || action === 'save-memory' && event.hook_event_name !== 'Stop') invalid('生命周期事件与操作不匹配。');
    const health = await connect();
    if (health.capabilities?.codexLifecycle !== 1) throw new AgentError('UPGRADE_REQUIRED', '请更新并重启此资料库的 MemoryUI 服务后启用生命周期记录。');
    return request('/api/codex-lifecycle/event', { method: 'POST', body: { client, action, event } });
  }
  if (['profile-status', 'profile-start', 'capture-event', 'capture-event-status'].includes(command)) {
    if (client !== 'codex') throw new AgentError('CODEX_CLIENT_REQUIRED', '个人档案自动建立目前仅供 Codex 使用。');
    rejectUnused(options, command === 'profile-start' ? ['client', 'input-file'] : ['client']);
    let input;
    if (command === 'profile-start') {
      if (!options['input-file']) invalid('建立资料需要 --input-file。');
      const details = await stat(path.resolve(options['input-file']));
      if (!details.isFile() || details.size > 8192) invalid('授权选择文件超过限制。');
      try { input = JSON.parse((await readFile(path.resolve(options['input-file']), 'utf8')).replace(/^\uFEFF/, '')); } catch { invalid('授权选择不是有效 JSON。'); }
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['consent', 'sources', 'categories', 'autoCapture', 'readNew', 'history', 'currentThreadId'].includes(key)) || input.consent !== true) invalid('需要明确且有效的来源授权。');
      if (input.sources?.includes('current_conversation') && !Object.hasOwn(input, 'currentThreadId') && hostThreadId) input.currentThreadId = hostThreadId;
    }
    if (command === 'capture-event' && (!eventInput || typeof eventInput !== 'object' || Array.isArray(eventInput))) invalid('用户消息事件需要从标准输入提供。');
    const health = await connect();
    if (health.capabilities?.profileOnboarding !== 1 || health.capabilities?.promptCapture !== 1) throw new AgentError('CAPABILITY_UNAVAILABLE', '请更新并重启此资料库的 MemoryUI 服务后建立个人档案。');
    if (command === 'profile-status') return request('/api/onboarding/status?client=codex');
    if (command === 'capture-event-status') return request('/api/onboarding/prompt-status');
    if (command === 'capture-event') return request('/api/onboarding/prompt', { method: 'POST', body: { client, event: eventInput } });
    return request('/api/onboarding/start', { method: 'POST', body: { client, ...input } });
  }
  if (command.startsWith('codex-')) {
    if (client !== 'codex') throw new AgentError('CODEX_CLIENT_REQUIRED', 'Codex 本机记忆导入仅供当前 Codex 客户端使用。');
    const start = command === 'codex-import-start', submit = command === 'codex-import-submit';
    rejectUnused(options, ['client', ...(start || submit ? ['input-file'] : command === 'codex-import-template' ? ['id'] : [])]);
    const input = start || submit ? await codexImportInput(options, start) : null;
    const id = submit ? input.requestId : command === 'codex-import-template' ? captureId(options.id) : null;
    const health = await connect();
    if (health.capabilities?.codexMemoryImport !== 1) throw new AgentError('CAPABILITY_UNAVAILABLE', '当前运行服务还未加载 Codex 记忆导入功能，请更新并重启对应 MemoryUI 服务。');
    if (command === 'codex-sources') return request('/api/codex-memory/status?client=codex');
    if (start) return request('/api/codex-memory/imports', { method: 'POST', body: { client, ...input } });
    if (submit) return request(`/api/codex-memory/imports/${id}/submit`, { method: 'POST', body: { client, version: input.version, entries: input.entries } });
    return request(`/api/codex-memory/imports/${id}?client=codex`);
  }
  if (command === 'setup') {
    rejectUnused(options, ['client', 'input-file']);
    const input = options['input-file'] ? await setupInput(options['input-file']) : null;
    await ensureService(settings, { fetchImpl, startService, wait });
    const response = input ? await request('/api/setup', { method: 'POST', body: { client, ...input } })
      : await request(`/api/setup?${new URLSearchParams({ client })}`);
    return { action: input ? 'setup-saved' : 'setup-status', ...response, url: `${settings.url}/?view=access&client=${encodeURIComponent(client)}`,
      notice: '本机模式；授权保存主题与新记忆读取集合分别记录。当前连接不提供跨设备账号同步。' };
  }
  if (command === 'capture-start') {
    rejectUnused(options, ['client']);
    await ensureService(settings, { fetchImpl, startService, wait });
    return { action: 'capture-started', client, ...await request('/api/setup/capture', { method: 'POST', body: { client } }) };
  }
  // Installed packages opt into lazy startup. Simulations never start a formal service.
  if (command === 'open') {
    rejectUnused(options, ['client']);
    await ensureService(settings, { fetchImpl, startService, wait });
    return { app: 'memoryui', workspaceId: settings.workspaceId, client, url: hostThreadId ? `${settings.url}/?view=home&threadId=${encodeURIComponent(hostThreadId)}` : settings.url, message: '请在当前客户端的网页面板或本机浏览器中打开此 URL。' };
  }
  if (command==='capture-request' || command==='capture') {
    rejectUnused(options,command==='capture-request'?['client','id']:['client','input-file']);
    const payload=command==='capture' ? await captureInput(options) : null;
    const id=captureId(payload?.requestId || options.id);
    await connect();
    if (command==='capture-request') return {action:'capture-template',client,...await request(`/api/capture-requests/${id}?${new URLSearchParams({client})}`)};
    return {action:'captured',client,...await request(`/api/capture-requests/${id}/submit`,{method:'POST',body:{client,version:payload.version,entries:payload.entries}})};
  }
  rejectUnused(options, command === 'status' ? ['client'] : ['remember', 'propose', 'update'].includes(command) ? [...OPTIONS] : ['client', ...(['search', 'recall'].includes(command) ? ['query'] : []), ...(command === 'recall' ? ['memory-type', 'limit', 'budget', 'scope-file'] : []), ...(command === 'show' ? ['id'] : [])]);
  const input = ['remember', 'propose', 'update'].includes(command) ? await mutationInput(options, command, clientName) : undefined;
  const recallScope = command === 'recall' && Object.hasOwn(options, 'scope-file') ? await recallScopeInput(options['scope-file']) : undefined;
  const health = await connect();
  if (command === 'status') return { ...health, client, url: settings.url };
  if (command === 'storage-status') return { client, ...await request('/api/storage/status') };
  if (command === 'recall') {
    const params = new URLSearchParams({ client, q: options.query });
    for (const [option, parameter] of [['memory-type', 'type'], ['limit', 'limit'], ['budget', 'budget']]) if (options[option] !== undefined) params.set(parameter, options[option]);
    if (recallScope !== undefined) params.set('scope', JSON.stringify(recallScope));
    return request(`/api/recall?${params}`);
  }
  const readContext = async (query, memoryId) => {
    const params = new URLSearchParams({ client: nonempty(client, '客户端编号', 100) });
    if (query !== undefined) params.set('q', nonempty(query, '查询', 2000));
    if (memoryId !== undefined) params.set('id', nonempty(memoryId, '记忆编号', 100));
    return request(`/api/context?${params}`);
  };
  if (command === 'remember') {
    const response = await request('/api/actions', { method: 'POST', body: { action: 'rememberMemory', args: [input.memory, input.options] } });
    const memory = response.result;
    const connection = response.snapshot.connections.find(entry => entry.id === client);
    const readableByCurrentClient = readableByClient(memory, connection, client);
    return { action: 'remembered', client, memory: currentMemory(memory), readableByCurrentClient, usagePolicy: REFERENCE_USAGE_POLICY,
      notice: readableByCurrentClient ? '已保存并确认；当前客户端可在下次任务中读取。' : '已保存并确认；当前客户端尚不能读取，可在面板的「AI 访问」中选择共享范围。' };
  }
  if (command === 'propose') {
    const response = await request('/api/actions', { method: 'POST', body: { action: 'proposeMemory', args: [input] } });
    const memory = response.result;
    const connection = response.snapshot.connections.find(entry => entry.id === client);
    const readableByCurrentClient = readableByClient(memory, connection, client);
    const notice = memory.confirmed ? '已有相同的已确认信息，保留原记录。'
      : !isUsableMemory(memory) ? '已有相同记录，保留其暂停、忽略或失效状态，没有恢复使用。'
      : readableByCurrentClient ? `已自动存入为参考记忆，${clientName} 可在确认前参考。` : '已自动存入为参考记忆；当前客户端尚不能读取，可在面板的「AI 访问」中选择共享范围。';
    return { action: 'proposed', client, memory: currentMemory(memory), readableByCurrentClient, usagePolicy: REFERENCE_USAGE_POLICY,
      captureOutcome: response.capture?.outcome, shouldNotifyUser: response.capture?.shouldNotifyUser === true, notice };
  }
  if (command === 'update') {
    const context = await readContext(undefined, input.id);
    const memory = context.memories.find((item) => item.id === input.id);
    if (!memory) throw new AgentError('MEMORY_NOT_READABLE', `此记忆未向 ${clientName} 授权、已暂停或已失效，请在面板中处理。`);
    const patch = Object.fromEntries(['content', 'category', 'workspace', 'memoryType', 'reviewReasons'].filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]));
    const response = await request('/api/actions', { method: 'POST', body: { action: 'updateMemory', args: [input.id, patch, { expectedRevision: input.expectedRevision }] } });
    return { action: 'updated', client, memory: currentMemory(response.result) };
  }
  if (command === 'search') return readContext(options.query);
  if (command === 'show') {
    const context = await readContext(undefined, options.id);
    const memory = context.memories.find((item) => item.id === nonempty(options.id, '记忆编号', 100));
    if (!memory) throw new AgentError('MEMORY_NOT_READABLE', '此记忆未向当前客户端授权、已暂停或已失效。');
    return { client: context.client, memory, usagePolicy: REFERENCE_USAGE_POLICY };
  }
  return readContext();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const env = { ...process.env };
    await loadEnvironment(WORKSPACE_ROOT, env);
    let eventInput;
    if (['capture-event', 'lifecycle-event'].includes(process.argv[2])) {
      process.stdin.setEncoding('utf8');
      let input = ''; for await (const chunk of process.stdin) { input += chunk.toString('utf8'); if (Buffer.byteLength(input, 'utf8') > 64 * 1024) invalid('用户消息事件超过大小限制。'); }
      try { eventInput = JSON.parse(input); } catch { invalid('用户消息事件不是有效 JSON。'); }
    }
    console.log(JSON.stringify(await runCommand(process.argv.slice(2), { env, eventInput }), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.code || 'AGENT_ERROR', message: error instanceof AgentError ? error.message : '记忆操作失败，请检查本机服务与输入文件。' }));
    process.exitCode = 1;
  }
}
