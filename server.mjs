import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchMem0Memories, getProviderStatus, ProviderError } from './src/providers/mem0.mjs';
import { MemoryStore, MemoryStoreError } from './src/memory-store.js';
import { createFileStorage, getWorkspaceId } from './src/server-storage.mjs';
import { MEMORY_TYPES } from './src/memory-types.js';
import { isUsableMemory, memoryReview } from './src/memory-policy.js';
import { selectTaskMemories, recallMemoryView, memoryContextView, REFERENCE_USAGE_POLICY, RETRIEVAL_METHOD } from './src/task-recall.mjs';
import { normalizeRecallScope, RecallScopeError } from './src/recall-scope.mjs';
import { CaptureBridge, CaptureBridgeError, createCaptureRequestStorage } from './src/capture-bridge.mjs';
import { readStorageStatus } from './src/storage-status.mjs';
import { CodexMemoryImport, CodexMemoryImportError, createCodexMemoryImportStorage } from './src/codex-memory-import.mjs';
import { CodexHistorySource } from './src/codex-history-source.mjs';
import { ProfileOnboarding, ProfileOnboardingError, createProfileOnboardingStorage } from './src/profile-onboarding.mjs';
import { PromptCaptureQueue, PromptCaptureError, createPromptCaptureStorage } from './src/codex-prompt-events.mjs';
import { createCodexReadOnlyTransport } from './src/codex-app-server.mjs';
import { createProfileWorker } from './src/profile-worker.mjs';
import { createCodexHookStatus } from './src/codex-hook-status.mjs';
import { getDataDirectory } from './src/server-storage.mjs';
import { ContextMemory, ContextMemoryError, createContextMemoryStorage } from './src/context-memory.mjs';
import { requestMemoryContext } from './src/context-request.mjs';
import { CodexConversationRecorder, CodexConversationRecorderError, createCodexConversationRecorderStorage } from './src/codex-conversation-recorder.mjs';
import { createCodexLifecycle, CodexLifecycleError, createCodexLifecycleStorage, codexWorkspaceProject } from './src/codex-lifecycle.mjs';

export { getWorkspaceId } from './src/server-storage.mjs';

const WORKSPACE_ROOT = fileURLToPath(new URL('.', import.meta.url));
// Read once when the process loads, so replacing files on disk does not make
// an old running backend advertise the newly installed version.
const { version: SERVICE_VERSION } = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const HOST = '127.0.0.1';
const ENV_NAMES = new Set(['MEM0_API_KEY', 'MEM0_USER_ID', 'MEM0_API_BASE_URL', 'MEMORYUI_DATA_DIR', 'MEMORYUI_WORKSPACE_ID', 'PORT']);
const MAX_REQUEST_BYTES = 128 * 1024;
const ACTIONS = new Set(['createMemory', 'rememberMemory', 'updateMemory', 'proposeMemory', 'confirmMemory', 'rejectMemory', 'setMemoryStatus', 'deleteMemory', 'updateConnection', 'importData', 'resetDemo', 'importMem0Snapshot']);
const SERVER_ONLY_PATHS = new Set(['server-storage.mjs', 'capture-bridge.mjs', 'atomic-file-storage.mjs', 'codex-memory-import.mjs',
  'codex-app-server.mjs', 'codex-history-source.mjs', 'profile-onboarding.mjs', 'codex-prompt-events.mjs', 'profile-worker.mjs', 'codex-hook-status.mjs', 'context-memory.mjs', 'context-request.mjs', 'codex-conversation-recorder.mjs', 'codex-lifecycle.mjs'].map(filename => `/src/${filename}`));
const serverOnlyPath = pathname => SERVER_ONLY_PATHS.has(pathname.toLowerCase()) || pathname.toLowerCase().startsWith('/src/providers/');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

// A deliberately small dotenv reader. Values are literal, never evaluated.
export async function loadEnvironment(root = WORKSPACE_ROOT, env = process.env) {
  let text;
  try {
    const envFile = path.join(root, '.env');
    const details = await stat(envFile);
    if (!details.isFile() || details.size > 65_536) throw new Error('Invalid environment file');
    text = await readFile(envFile, 'utf8');
  }
  catch (error) { if (error.code === 'ENOENT') return; throw new Error('无法读取服务器 .env 文件。'); }
  if (text.length > 65_536) throw new Error('服务器 .env 文件过大。');
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match || !ENV_NAMES.has(match[1]) || env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const end = value.lastIndexOf(quote);
      if (end < 1 || !/^(?:\s*#.*)?$/.test(value.slice(end + 1))) continue;
      value = value.slice(1, end);
    } else value = value.replace(/\s+#.*$/, '').trim();
    env[match[1]] = value;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body.error && !body.code ? { ...body, code: body.error } : body));
}

class ApiError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

function sendError(res, error, storage) {
  const send = (status, body) => sendJson(res, status, { ...body, ...(storage ? { storage } : {}) });
  if (error instanceof RecallScopeError) { send(400, { error: error.code, code: error.code, message: error.message }); return; }
  if (error instanceof ApiError || error instanceof CodexLifecycleError || error instanceof CodexConversationRecorderError || error instanceof ContextMemoryError || error instanceof ProviderError || error instanceof CaptureBridgeError || error instanceof CodexMemoryImportError || error instanceof ProfileOnboardingError || error instanceof PromptCaptureError) { send(error.status, { error: error.code, code: error.code, message: error.message }); return; }
  if (error instanceof MemoryStoreError) {
    const status = { VALIDATION_ERROR: 400, NOT_FOUND: 404, REVISION_CONFLICT: 409, STORAGE_UNAVAILABLE: 503, STORAGE_INVALID: 503 }[error.code] || 400;
    send(status, { error: error.code, code: error.code, message: error.message });
    return;
  }
  send(500, { error: 'SERVER_ERROR', code: 'SERVER_ERROR', message: '本地服务暂时无法完成操作，原始记忆文件不会被自动重置。' });
}

async function readJsonBody(req) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || '')) throw new ApiError('JSON_REQUIRED', '请使用 application/json 提交操作。', 415);
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new ApiError('REQUEST_TOO_LARGE', '操作数据超过 128 KiB 限制。', 413);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let exceeded = false;
    req.on('data', chunk => {
      if (exceeded) return;
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        exceeded = true;
        chunks.length = 0;
        // Keep draining without buffering so a chunked sender gets a clear 413.
        reject(new ApiError('REQUEST_TOO_LARGE', '操作数据超过 128 KiB 限制。', 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (exceeded) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ApiError('INVALID_JSON', '操作数据不是有效 JSON。')); }
    });
    req.on('error', () => reject(new ApiError('INVALID_REQUEST', '操作请求未完整接收。')));
  });
}

function validateAction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['action', 'args'].includes(key)) ||
      typeof input.action !== 'string' || !ACTIONS.has(input.action) || !Array.isArray(input.args) || input.args.length > 3) {
    throw new ApiError('INVALID_ACTION', '操作必须包含允许的 action 和 args 列表。');
  }
  const ranges = { createMemory: [1, 2], rememberMemory: [1, 2], updateMemory: [2, 3], proposeMemory: [1, 1], confirmMemory: [1, 3], rejectMemory: [1, 2], setMemoryStatus: [2, 3], deleteMemory: [1, 2], updateConnection: [2, 2], importData: [1, 2], resetDemo: [0, 0], importMem0Snapshot: [1, 1] };
  const [minimum, maximum] = ranges[input.action];
  if (input.args.length < minimum || input.args.length > maximum) throw new ApiError('INVALID_ACTION_ARGS', '操作参数数量不正确。');
  return input;
}

function applyAction(store, input) {
  const { action, args } = validateAction(input);
  if (['confirmMemory', 'rejectMemory', 'setMemoryStatus', 'deleteMemory'].includes(action)) {
    const optionsIndex = { confirmMemory: 2, rejectMemory: 1, setMemoryStatus: 2, deleteMemory: 1 }[action];
    const options = args[optionsIndex];
    if (options !== undefined) {
      const allowedOptions = action === 'confirmMemory' ? ['expectedRevision', 'expectedAbsentProfileField'] : ['expectedRevision'];
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !allowedOptions.includes(key)) ||
          !Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1) throw new ApiError('INVALID_REVISION', '操作版本号必须是正整数。');
      const memory = store.getSnapshot().memories.find(entry => entry.id === args[0]);
      if (!memory) throw new ApiError('NOT_FOUND', '找不到这条记忆。', 404);
      if (memory.revision !== options.expectedRevision) throw new ApiError('REVISION_CONFLICT', '这条记忆已被修改，请刷新后重试。', 409);
    }
  }
  if (action === 'updateMemory' && args[2] !== undefined) {
    const options = args[2];
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'expectedRevision') ||
        !Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1) throw new ApiError('INVALID_REVISION', '操作版本号必须是正整数。');
  }
  return store[action](...args);
}

function localRequest(req, port) {
  const authorities = new Set([`${HOST}:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!authorities.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'http:' || parsed.origin !== `http://${req.headers.host}`) return false;
    } catch { return false; }
  }
  return !req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']);
}

function staticPath(rawUrl) {
  // Inspect before URL normalization, including Windows separators and encoding.
  const rawPath = rawUrl.split('?')[0];
  let decoded;
  try { decoded = decodeURIComponent(rawPath); }
  catch { return null; }
  if (!decoded.startsWith('/') || /[\\\0]/.test(decoded) || decoded.includes('%') ||
      decoded.split('/').some(part => part === '..' || part === '.' || part.startsWith('.'))) return null;
  if (decoded === '/') return '/index.html';
  if (decoded === '/index.html') return decoded;
  if (!decoded.startsWith('/src/') && !decoded.startsWith('/public/')) return null;
  if (serverOnlyPath(decoded) || !MIME_TYPES[path.extname(decoded).toLowerCase()]) return null;
  return decoded;
}

export function createPreviewServer({ root = WORKSPACE_ROOT, env = process.env, fetchImpl = globalThis.fetch, store: suppliedStore, simulation = false, bridgeStorage, nativeMemoryStorage, codexHome,
  profileStorage, promptStorage, contextStorage, recordingStorage, lifecycleStorage, historyTransport, profileModelRunner, enableProfileWorker, enableHookStatusProbe, enableConversationRecorder } = {}) {
  let importInFlight = null;
  let store = suppliedStore;
  let memoryStorage;
  const workspaceId = getWorkspaceId(root, env);
  const account = env.MEMORYUI_ACCOUNT_NAME && env.MEMORYUI_ACCOUNT_KIND === 'local-test'
    ? { id: workspaceId, name: String(env.MEMORYUI_ACCOUNT_NAME).slice(0, 80), kind: 'local-test' } : null;
  const getStore = () => {
    if (!store) { memoryStorage = simulation === true ? null : createFileStorage({ root, env }); store = new MemoryStore({ storage: memoryStorage }); }
    return store;
  };
  let contextMemory;
  const getContextMemory = () => {
    if (!contextMemory) contextMemory = new ContextMemory({ storage: contextStorage === undefined
      ? simulation || suppliedStore ? null : createContextMemoryStorage({ root, env }) : contextStorage });
    return contextMemory;
  };
  // Supplied stores (in particular isolated simulations) must never fall back
  // to the formal personal request file. Production bootstrap opts in below.
  const capture = new CaptureBridge({ getStore, storage: simulation === true ? null : bridgeStorage === undefined ? suppliedStore ? null : createCaptureRequestStorage({ root, env }) : bridgeStorage });
  const codexImport = new CodexMemoryImport({ getStore, captureBridge: capture, env, codexHome,
    storage: nativeMemoryStorage === undefined ? simulation === true || suppliedStore ? null : createCodexMemoryImportStorage({ root, env }) : nativeMemoryStorage });
  // Installed services run from the stable vault. Child processes must also
  // avoid holding the replaceable runtime directory open during upgrades.
  const transport = historyTransport || createCodexReadOnlyTransport({ env, cwd: process.cwd() });
  let conversationRecorder;
  const getConversationRecorder = () => {
    if (!conversationRecorder) conversationRecorder = new CodexConversationRecorder({ transport, getContextMemory,
      automaticPermission: () => { const permission = promptQueue.permission(); return permission.allowed && permission.categories.includes('当前项目'); },
      storage: recordingStorage === undefined ? simulation || suppliedStore ? null : createCodexConversationRecorderStorage({ root, env }) : recordingStorage });
    return conversationRecorder;
  };
  const recordingEnabled = enableConversationRecorder ?? (!simulation && !suppliedStore);
  let recordingTimer;
  const recordingStatus = () => ({ currentThreadId: env.CODEX_THREAD_ID || null, recording: getConversationRecorder().status() });
  const onboarding = new ProfileOnboarding({ getStore, captureBridge: capture, nativeSource: codexImport,
    historySource: new CodexHistorySource({ transport }), storage: profileStorage === undefined ? simulation || suppliedStore ? null : createProfileOnboardingStorage({ root, env }) : profileStorage });
  const promptQueue = new PromptCaptureQueue({ getStore, grantProvider: client => onboarding.grant(client),
    storage: promptStorage === undefined ? simulation || suppliedStore ? null : createPromptCaptureStorage({ root, env }) : promptStorage });
  const workerEnabled = enableProfileWorker ?? Boolean(profileModelRunner || (!simulation && !suppliedStore));
  const hookStatus = createCodexHookStatus({ transport, cwd: root, enabled: workerEnabled && (enableHookStatusProbe ?? (!simulation && !suppliedStore)) });
  const worker = createProfileWorker({ onboarding, promptQueue, captureBridge: capture, directory: path.join(getDataDirectory(root, env), 'profile-worker'), env,
    ...(profileModelRunner ? { modelRunner: profileModelRunner } : {}) });
  const lifecycle = createCodexLifecycle({ promptQueue, getRecorder: getConversationRecorder, getContextMemory, recordingEnabled,
    schedulePrompts: () => workerEnabled ? worker.schedulePrompts() : Promise.resolve(),
    storage: lifecycleStorage === undefined ? simulation || suppliedStore ? null : createCodexLifecycleStorage({ root, env }) : lifecycleStorage });
  const profileStatus = client => {
    const automatic = promptQueue.status();
    return { ...onboarding.status(client), worker: { enabled: workerEnabled, ...worker.status() }, autoCapture: {
      ...automatic, enabled: automatic.allowed, pendingCount: automatic.counts.pending, processing: automatic.counts.processing > 0,
      // An accepted local API event does not verify installation of the actual
      // host hook. Keep provider trust separate from queue activity.
      ...hookStatus.read(), receiving: automatic.total > 0,
    } };
  };
  const storageStatus = () => ({
    memory: store ? readStorageStatus({ getStatus: () => store.getStorageStatus() })
      : memoryStorage !== undefined ? readStorageStatus(memoryStorage) : { status: simulation ? 'in-memory' : 'unknown', issues: [] },
    captureRequests: readStorageStatus({ getStatus: () => capture.getStorageStatus() }),
  });
  const sendOwnerJson = (res, status, body) => sendJson(res, status, { ...body, storage: storageStatus() });
  let closed = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    const port = req.socket.localPort;
    if (!localRequest(req, port)) {
      sendJson(res, 403, { error: 'LOCAL_REQUEST_REQUIRED', message: '请从本机预览页面访问。' });
      return;
    }
    let url;
    try { url = new URL(req.url, `http://${HOST}:${port}`); }
    catch { sendJson(res, 400, { error: 'INVALID_URL' }); return; }
    if (url.pathname.startsWith('/api/')) {
      if (req.headers['x-memoryui-mode'] === 'simulation' && simulation !== true) { sendJson(res, 409, { error: 'SIMULATION_REQUIRED', message: '模拟请求不能访问正式资料库。' }); return; }
      if (url.pathname.startsWith('/api/codex-conversations/')) {
        try {
          if (url.search) throw new ApiError('QUERY_NOT_SUPPORTED', '对话记录接口不接受查询参数。');
          if (['/api/codex-conversations/status', '/api/codex-conversations/threads'].includes(url.pathname)) {
            if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
            let result;
            if (url.pathname.endsWith('/threads')) {
              const metadata = await new CodexHistorySource({ transport }).metadata();
              result = { ...metadata, threads: metadata.threads.map(thread => ({ ...thread,
                ...(thread.workspace ? { projectId: codexWorkspaceProject(thread.workspace).projectId } : {}),
              })) };
            } else result = recordingStatus();
            sendOwnerJson(res, 200, result); return;
          }
          if (!['/api/codex-conversations/start', '/api/codex-conversations/stop'].includes(url.pathname)) throw new ApiError('NOT_FOUND', '找不到此对话记录接口。', 404);
          if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
          const input = await readJsonBody(req);
          const recorder = getConversationRecorder();
          if (url.pathname.endsWith('/start')) {
            recorder.start(input);
            void recorder.syncAfterCurrent().catch(() => {});
            sendOwnerJson(res, 202, recordingStatus()); return;
          }
          recorder.stop(input);
          sendOwnerJson(res, 200, recordingStatus()); return;
        } catch (error) { sendError(res, error, storageStatus()); return; }
      }
      if (url.pathname.startsWith('/api/codex-lifecycle/')) {
        try {
          if (url.search) throw new ApiError('QUERY_NOT_SUPPORTED', '生命周期入口不接受查询参数。');
          if (url.pathname === '/api/codex-lifecycle/status' && req.method === 'GET') { sendOwnerJson(res, 200, lifecycle.status()); return; }
          if (url.pathname === '/api/codex-lifecycle/event' && req.method === 'POST') { sendOwnerJson(res, 202, lifecycle.handle(await readJsonBody(req))); return; }
          throw new ApiError('NOT_FOUND', '找不到此生命周期入口或方法。', 404);
        } catch (error) { sendError(res, error, storageStatus()); }
        return;
      }
      if (url.pathname.startsWith('/api/context-memory/')) {
        try {
          if (url.search) throw new ApiError('QUERY_NOT_SUPPORTED', '记忆请求不接受 URL 查询参数。');
          if (url.pathname === '/api/context-memory/state') {
            if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
            sendOwnerJson(res, 200, { snapshot: getContextMemory().getSnapshot({ withCompression: true }), simulation }); return;
          }
          const routes = ['/api/context-memory/conversations', '/api/context-memory/project', '/api/context-memory/request'];
          if (!routes.includes(url.pathname)) throw new ApiError('NOT_FOUND', '找不到此记忆接口。', 404);
          if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
          const body = await readJsonBody(req);
          if (!body || Object.getPrototypeOf(body) !== Object.prototype) throw new ApiError('INVALID_ARGUMENT', '需要有效的记忆请求对象。');
          const { client, consent, ...input } = body;
          if (!['chatgpt', 'workbuddy', 'codex', 'claude-code'].includes(client)) throw new ApiError('INVALID_CLIENT', '请选择有效的客户端。');
          const connection = getStore().getSnapshot().connections.find(entry => entry.id === client);
          if (!connection?.enabled || connection.mode !== 'local-agent') throw new ApiError('CLIENT_NOT_AUTHORIZED', '请先在 AI 访问中启用所选客户端。', 403);
          if (url.pathname === '/api/context-memory/request') {
            if (Object.hasOwn(body, 'consent')) throw new ApiError('INVALID_ARGUMENT', '读取请求只接受本次范围和问题。');
            sendJson(res, 200, requestMemoryContext({ store: getStore(), contextMemory: getContextMemory(), client, input })); return;
          }
          if (consent !== true) throw new ApiError('CONSENT_REQUIRED', '请明确同意保存本次可见对话或项目记录。', 403);
          const result = url.pathname.endsWith('/conversations') ? getContextMemory().saveConversation(client, input) : getContextMemory().saveProjectMemory(client, input);
          sendOwnerJson(res, 200, result); return;
        } catch (error) { sendError(res, error, storageStatus()); return; }
      }
      if (url.pathname.startsWith('/api/onboarding/')) {
        try {
          if (url.pathname === '/api/onboarding/status') {
            if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
            if ([...url.searchParams.keys()].some(key => key !== 'client') || url.searchParams.getAll('client').length !== 1) throw new ApiError('INVALID_ARGUMENT', '需要一个有效客户端。');
            sendOwnerJson(res, 200, profileStatus(url.searchParams.get('client'))); return;
          }
          if (url.pathname === '/api/onboarding/start') {
            if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
            if (url.search) throw new ApiError('QUERY_NOT_SUPPORTED', '建立资料不接受查询参数。');
            const data = await onboarding.start(await readJsonBody(req), { deferSourceRead: true });
            if (workerEnabled) void worker.schedule(data.job.id);
            sendOwnerJson(res, 202, { ...data, ...profileStatus('codex') }); return;
          }
          if (url.pathname === '/api/onboarding/prompt-status') {
            if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
            if (url.search) throw new ApiError('QUERY_NOT_SUPPORTED', '采集状态不接受查询参数。');
            sendOwnerJson(res, 200, promptQueue.status()); return;
          }
          if (url.pathname === '/api/onboarding/prompt') {
            if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
            if (url.search) throw new ApiError('QUERY_NOT_SUPPORTED', '采集入口不接受查询参数。');
            const input = await readJsonBody(req);
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['client', 'event'].includes(key)) || input.client !== 'codex') throw new ApiError('INVALID_ARGUMENT', '采集入口只接受当前 Codex 用户消息事件。');
            const receipt = promptQueue.enqueue(input);
            if (receipt.accepted && workerEnabled) void worker.schedulePrompts();
            sendOwnerJson(res, 202, receipt); return;
          }
          throw new ApiError('NOT_FOUND', '找不到此个人资料流程入口。', 404);
        } catch (error) { sendError(res, error, storageStatus()); }
        return;
      }
      if (url.pathname.startsWith('/api/codex-memory/')) {
        try {
          if (url.pathname === '/api/codex-memory/status') {
            if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
            if ([...url.searchParams.keys()].some(key => key !== 'client') || url.searchParams.getAll('client').length !== 1) throw new ApiError('INVALID_ARGUMENT', '需要且仅接受一个客户端参数。');
            sendOwnerJson(res, 200, await codexImport.status(url.searchParams.get('client'))); return;
          }
          if (url.pathname === '/api/codex-memory/imports') {
            if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
            if (url.search) throw new ApiError('QUERY_NOT_SUPPORTED', '导入操作不接受查询参数。');
            sendOwnerJson(res, 201, await codexImport.start(await readJsonBody(req))); return;
          }
          const route = /^\/api\/codex-memory\/imports\/([0-9a-f-]{36})(?:\/(submit))?$/i.exec(url.pathname);
          if (!route) throw new ApiError('NOT_FOUND', '找不到此 Codex 记忆导入入口。', 404);
          if (!route[2] && req.method === 'GET') {
            if ([...url.searchParams.keys()].some(key => key !== 'client') || url.searchParams.getAll('client').length !== 1) throw new ApiError('INVALID_ARGUMENT', '需要且仅接受一个客户端参数。');
            sendOwnerJson(res, 200, await codexImport.get(route[1], url.searchParams.get('client'))); return;
          }
          if (route[2] && req.method === 'POST') {
            if (url.search) throw new ApiError('QUERY_NOT_SUPPORTED', '导入操作不接受查询参数。');
            sendOwnerJson(res, 200, await codexImport.submit(route[1], await readJsonBody(req))); return;
          }
          res.setHeader('Allow', route[2] ? 'POST' : 'GET'); sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return;
        } catch (error) { sendError(res, error, storageStatus()); }
        return;
      }
      // Owner-only controls: these are deliberately absent from agent tools and
      // the generic action allowlist. Previewing never grants access.
      if (['/api/profile-sharing', '/api/profile-sharing/preview'].includes(url.pathname)) {
        try {
          if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: '请从面板预览并提交共享范围。' }); return; }
          if (url.search) throw new ApiError('QUERY_NOT_SUPPORTED', '此接口不接受查询参数。');
          const input = await readJsonBody(req);
          const preview = url.pathname.endsWith('/preview');
          const allowed = preview ? ['client', 'enabled', 'categories'] : ['client', 'enabled', 'categories', 'previewToken'];
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))
              || typeof input.client !== 'string' || typeof input.enabled !== 'boolean' || !Array.isArray(input.categories)
              || (!preview && typeof input.previewToken !== 'string')) throw new ApiError('INVALID_PROFILE_SHARING', '请先选择 AI 和主题，再预览共享范围。');
          const { client, ...settings } = input;
          const localStore = getStore();
          const result = preview ? localStore.previewProfileSharing(client, settings) : localStore.updateProfileSharing(client, settings);
          sendOwnerJson(res, 200, { ...result, snapshot: localStore.getSnapshot() });
        } catch (error) { sendError(res, error, storageStatus()); }
        return;
      }
      if (url.pathname === '/api/setup' || url.pathname === '/api/setup/capture') {
        try {
          if (url.pathname === '/api/setup' && req.method === 'GET') {
            if ([...url.searchParams.keys()].some(key => key !== 'client') || url.searchParams.getAll('client').length !== 1) throw new ApiError('INVALID_QUERY', '需要且仅允许一个 client 参数。');
            sendOwnerJson(res, 200, getStore().getAgentSetup(url.searchParams.get('client'))); return;
          }
          if (req.method === 'POST') {
            if (url.search) throw new ApiError('QUERY_NOT_SUPPORTED', '此接口不接受查询参数。');
            const input = await readJsonBody(req);
            const setupCapture = url.pathname === '/api/setup/capture';
            const allowed = setupCapture ? ['client'] : ['client', 'categories', 'autoCapture', 'readNew'];
            if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(input, key))) throw new ApiError('INVALID_SETUP', '首次设置包含未知字段或缺少必要字段。');
            const localStore = getStore();
            if (setupCapture) {
              const setup = localStore.getAgentSetup(input.client);
              if (!setup.configured) throw new ApiError('SETUP_REQUIRED', '请先确认当前智能体的保存主题与读取范围。', 409);
              sendOwnerJson(res, 201, capture.create({ client: input.client, categories: setup.setup.categories })); return;
            }
            const { client, ...settings } = input;
            sendOwnerJson(res, 200, localStore.updateAgentSetup(client, settings)); return;
          }
          res.setHeader('Allow', url.pathname === '/api/setup' ? 'GET, POST' : 'POST');
          sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: '首次设置接口的请求方式无效。' });
        } catch (error) { sendError(res, error, storageStatus()); }
        return;
      }
      if (url.pathname === '/api/capture-requests' || url.pathname.startsWith('/api/capture-requests/')) {
        try {
          if (url.pathname === '/api/capture-requests') {
            if (url.search) throw new ApiError('QUERY_NOT_SUPPORTED', '此接口不接受查询参数。');
            if (req.method === 'GET') { sendOwnerJson(res, 200, capture.list()); return; }
            if (req.method === 'POST') { sendOwnerJson(res, 201, capture.create(await readJsonBody(req))); return; }
            res.setHeader('Allow', 'GET, POST');
          } else {
            const route = /^\/api\/capture-requests\/([^/]+)(?:\/(submit|cancel))?$/.exec(url.pathname);
            if (!route) throw new ApiError('NOT_FOUND', '找不到此整理接口。', 404);
            const [, id, action] = route;
            if (!action && req.method === 'GET') {
              if ([...url.searchParams.keys()].some(key => key !== 'client') || url.searchParams.getAll('client').length !== 1) throw new ApiError('INVALID_QUERY', '需要且仅允许一个 client 参数。');
              sendOwnerJson(res, 200, capture.get(id, url.searchParams.get('client'))); return;
            }
            if (action && req.method === 'POST') {
              if (url.search) throw new ApiError('QUERY_NOT_SUPPORTED', '此接口不接受查询参数。');
              const input = await readJsonBody(req);
              sendOwnerJson(res, 200, action === 'submit' ? capture.submit(id, input) : capture.cancel(id, input)); return;
            }
            res.setHeader('Allow', action ? 'POST' : 'GET');
          }
          sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: '整理接口的请求方式无效。' });
        } catch (error) { sendError(res, error, storageStatus()); }
        return;
      }
      if (!['/api/health', '/api/state', '/api/storage/status', '/api/context', '/api/recall', '/api/actions', '/api/provider/status', '/api/provider/memories'].includes(url.pathname)) { sendJson(res, 404, { error: 'NOT_FOUND', code: 'NOT_FOUND' }); return; }
      const method = url.pathname === '/api/actions' ? 'POST' : 'GET';
      if (req.method !== method) { res.setHeader('Allow', method); sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', code: 'METHOD_NOT_ALLOWED', message: `此接口只支持 ${method}。` }); return; }
      if (url.search && !['/api/context', '/api/recall'].includes(url.pathname)) { sendJson(res, 400, { error: 'QUERY_NOT_SUPPORTED', code: 'QUERY_NOT_SUPPORTED', message: '此接口不接受查询参数。' }); return; }
      try {
        if (url.pathname === '/api/provider/status') { sendJson(res, 200, getProviderStatus(env)); return; }
        if (url.pathname === '/api/health') { getStore(); sendJson(res, 200, { app: 'memoryui', protocolVersion: 1, version: SERVICE_VERSION, capabilities: { contextMemory: 1, recallScope: 1, captureTarget: 1, readAudit: 1, exactRead: 1, captureAudit: 1, storageStatus: 1, codexMemoryImport: 1, profileOnboarding: 1, promptCapture: 1, codexLifecycle: 1 }, workspaceId, status: 'ready', ...(simulation === true ? { simulation: true } : {}) }); return; }
        if (url.pathname === '/api/storage/status') { sendOwnerJson(res, 200, { simulation: simulation === true }); return; }
        if (url.pathname === '/api/state') { sendOwnerJson(res, 200, { snapshot: getStore().getSnapshot(), simulation: simulation === true, ...(account ? { account } : {}) }); return; }
        if (url.pathname === '/api/actions') {
          const input = await readJsonBody(req);
          const localStore = getStore();
          const previousReferences = input?.action === 'proposeMemory' ? new Map(localStore.getSnapshot().memories.map(memory => [memory.id, { revision: memory.revision, review: memoryReview(memory) }])) : null;
          const result = applyAction(localStore, input);
          let capture;
          if (previousReferences) {
            const previous = previousReferences.get(result.id), review = memoryReview(result);
            capture = { outcome: previous ? previous.revision === result.revision ? 'unchanged' : 'updated' : 'created',
              shouldNotifyUser: isUsableMemory(result) && review.reviewNeeded && (!previous || JSON.stringify([...previous.review.reviewReasons].sort()) !== JSON.stringify([...review.reviewReasons].sort())) };
          }
          sendOwnerJson(res, 200, { result, snapshot: localStore.getSnapshot(), ...(capture ? { capture } : {}) });
          return;
        }
        if (['/api/context', '/api/recall'].includes(url.pathname)) {
          const taskRecall = url.pathname === '/api/recall';
          const parameters = taskRecall ? ['client', 'q', 'limit', 'budget', 'type', 'scope'] : ['client', 'q', 'id'];
          if ([...url.searchParams.keys()].some(key => !parameters.includes(key)) || parameters.some(key => url.searchParams.getAll(key).length > 1)) throw new ApiError('INVALID_QUERY', '查询参数未知或重复。');
          const client = url.searchParams.get('client') ?? 'codex';
          const query = (url.searchParams.get('q') ?? '').trim();
          if (!client || client.length > 100 || query.length > 2000) throw new ApiError('INVALID_QUERY', 'client 或 q 参数无效。');
          const requestedId = url.searchParams.get('id');
          if (requestedId !== null && (!requestedId.trim() || requestedId.length > 100 || url.searchParams.has('q'))) throw new ApiError('INVALID_QUERY', '单条读取需要有效 id，且不能同时指定 q。');
          let scope;
          if (taskRecall && url.searchParams.has('scope')) {
            const rawScope = url.searchParams.get('scope');
            if (Buffer.byteLength(rawScope, 'utf8') > 8192) throw new ApiError('INVALID_RECALL_SCOPE', '本次读取范围超过 8 KiB。');
            let parsedScope;
            try { parsedScope = JSON.parse(rawScope); }
            catch { throw new ApiError('INVALID_RECALL_SCOPE', '本次读取范围不是有效 JSON。'); }
            scope = normalizeRecallScope(parsedScope);
          }
          const localStore = getStore();
          const connection = localStore.getSnapshot().connections.find(entry => entry.id === client);
          if (!connection) throw new ApiError('NOT_FOUND', '找不到这个本地智能体。', 404);
          if (!connection.enabled || connection.mode !== 'local-agent') throw new ApiError('CLIENT_NOT_AUTHORIZED', '这个智能体尚未获得本机读取授权。', 403);
          const readable = localStore.getReadableMemories(client);
          const real = readable.filter(memory => memory.source.platform.trim() !== '演示对话' && !memory.id.startsWith('demo-'));
          const excludedDemoCount = readable.length - real.length;
          if (taskRecall) {
            if (!query) throw new ApiError('INVALID_QUERY', '按任务召回需要提供当前问题或关键词 q。');
            const number = (key, fallback, min, max) => {
              const raw = url.searchParams.get(key);
              if (raw === null) return fallback;
              if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new ApiError('INVALID_QUERY', `${key} 必须是 ${min}–${max} 的整数。`);
              return Number(raw);
            };
            const limit = number('limit', 8, 1, 20), budget = number('budget', 6000, 256, 16000);
            const memoryType = url.searchParams.get('type') ?? 'all';
            if (memoryType !== 'all' && !Object.hasOwn(MEMORY_TYPES, memoryType)) throw new ApiError('INVALID_QUERY', '记忆方式无效。');
            const result = selectTaskMemories(real, { query, limit, budget, memoryType, scope });
            const memories = result.selected.map(recallMemoryView);
            localStore.recordRead(client, memories.map(memory => memory.id), {
              kind: 'recall', method: RETRIEVAL_METHOD, memoryType, limit,
              budgetChars: budget, returnedChars: result.usedChars, ...(scope === undefined ? {} : { scope }),
            }, result.selected.map(entry => entry.memory));
            sendJson(res, 200, { client, memories, count: memories.length, excludedDemoCount, usagePolicy: REFERENCE_USAGE_POLICY,
              retrieval: { method: RETRIEVAL_METHOD, query, limit, budgetChars: budget, returnedChars: result.usedChars, matchedCount: result.matchedCount, omittedCount: result.omittedCount,
                ...(scope === undefined ? {} : { scope: result.scope, scopePolicy: result.scopePolicy }) },
              readAt: localStore.getSnapshot().connections.find(entry => entry.id === client).lastReadAt,
              notice: memories.length ? memories.some(memory => memory.derived?.kind === 'age_from_birthday') ? '年龄按已授权的出生日期即时计算，标明计算日期并沿用来源核实级别；不会写入新的年龄记录，其他内容保留原文。' : '返回授权范围内与任务相关的完整记忆，已确认信息优先；未确认内容已存入并作为参考，需核对的理由随条目返回。匹配依据不是置信度。' : result.matchedCount ? '匹配的记忆超出当前预算，请增加 budget 或缩小问题。' : '没有找到相关的授权记忆，请换用更具体的关键词；不要据此猜测用户资料。' });
            return;
          }
          const needle = query.toLocaleLowerCase();
          const filtered = real.filter(memory => requestedId !== null ? memory.id === requestedId : !needle || `${memory.content}\n${memory.category}`.toLocaleLowerCase().includes(needle))
            .sort((a, b) => Number(b.confirmed === true) - Number(a.confirmed === true));
          localStore.recordRead(client, filtered.map(memory => memory.id), { kind: requestedId === null ? 'context' : 'show' });
          // Return current records with their verification level. Old history/source excerpts can contain
          // superseded claims and are not appropriate as the agent's context.
          const readableIds = new Set((requestedId === null ? real : filtered).map(memory => memory.id));
          const memories = filtered.map(memory => memoryContextView(memory, { readableIds }));
          sendJson(res, 200, { client, memories, count: memories.length, excludedDemoCount, usagePolicy: REFERENCE_USAGE_POLICY, readAt: localStore.getSnapshot().connections.find(entry => entry.id === client).lastReadAt, notice: '已确认与参考记忆均默认返回，并保留确认级别；仅包含未到期且已授权的真实记忆，演示样例不会进入智能体上下文。' });
          return;
        }
        // Concurrent clicks share a single read and do not multiply API requests.
        if (!importInFlight) importInFlight = fetchMem0Memories({ env, fetchImpl }).finally(() => { importInFlight = null; });
        sendJson(res, 200, await importInFlight);
      } catch (error) {
        sendError(res, error, storageStatus());
      }
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
    const requestPath = staticPath(req.url);
    if (!requestPath) { sendJson(res, 404, { error: 'NOT_FOUND' }); return; }
    try {
      const candidate = await realpath(path.join(root, requestPath.slice(1)));
      const realRoot = await realpath(root);
      const relative = path.relative(realRoot, candidate);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Outside root');
      // Only files from the whitelisted folders remain accessible after symlink resolution.
      if (relative !== 'index.html' && !relative.startsWith(`src${path.sep}`) && !relative.startsWith(`public${path.sep}`)) throw new Error('Not public');
      if (serverOnlyPath(`/${relative.split(path.sep).join('/')}`) || relative.split(path.sep).some(part => part.startsWith('.'))) throw new Error('Not public');
      if (!MIME_TYPES[path.extname(candidate).toLowerCase()]) throw new Error('Not a frontend file');
      const details = await stat(candidate);
      if (!details.isFile() || details.size > 10 * 1024 * 1024) throw new Error('Not a small static file');
      const content = await readFile(candidate);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(candidate).toLowerCase()] || 'application/octet-stream', 'Content-Length': content.length });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch { sendJson(res, 404, { error: 'NOT_FOUND' }); }
  });
  server.on('listening', () => {
    closed = false;
    if (recordingEnabled) {
      void (async () => { try {
        const currentThreadId = env.CODEX_THREAD_ID;
        const recorder = getConversationRecorder();
        if (typeof currentThreadId === 'string' && currentThreadId.trim() && currentThreadId.length <= 200
          && !recorder.status().subscriptions.some(subscription => subscription.threadId === currentThreadId)) {
          const metadata = await transport.request('thread/read', { threadId: currentThreadId, includeTurns: false });
          const workspace = metadata?.thread?.cwd;
          if (!closed && metadata?.thread?.id === currentThreadId && typeof workspace === 'string' && path.isAbsolute(workspace)
            && !recorder.status().subscriptions.some(subscription => subscription.threadId === currentThreadId)) {
            const saved = getContextMemory().getSnapshot().conversations.find(item => item.client === 'codex' && item.conversationId === currentThreadId);
            const projectId = saved ? saved.projectId : codexWorkspaceProject(workspace).projectId;
            recorder.start({ threadId: currentThreadId, ...(projectId === null ? {} : { projectId }), consent: true });
            void recorder.syncAfterCurrent().catch(() => {});
          }
        }
      } catch { /* Unavailable metadata never binds a thread to the installed runtime folder. */ } })();
      const pollRecordings = () => { if (!closed) void getConversationRecorder().sync().catch(() => {}); };
      recordingTimer = setInterval(pollRecordings, 3000);
      recordingTimer.unref?.();
      pollRecordings();
    }
    if (!workerEnabled) return;
    // Restart only work that was still queued/running. A failed or uncertain
    // model result is never released or marked retryable by the HTTP server.
    try {
      for (const job of onboarding.status('codex').jobs) {
        if (!['queued', 'running'].includes(job.status)) continue;
        try {
          onboarding.get(job.id, 'codex', { includeSources: true });
          void worker.schedule(job.id).catch(() => {});
        } catch { /* The current scope may have been revoked since enqueue. */ }
      }
    } catch { /* Invalid storage stays intact and is reported by status APIs. */ }
    void (async () => {
      // A processing record retains its original job and verified capture
      // binding; the worker decides whether its result can safely be resumed.
      // Do not turn error/failed records back into pending work.
      for (let attempt = 0; !closed && attempt < 300; attempt++) {
        let pending, processing;
        try { pending = promptQueue.pending(1); processing = promptQueue.processing(); }
        catch { return; }
        if (!pending.length && !processing.length) return;
        const fingerprint = JSON.stringify({ pending: pending.map(record => record.sourceId), processing: processing.map(job => job.batchId) });
        try { await worker.schedulePrompts(); } catch { return; }
        try {
          const after = JSON.stringify({ pending: promptQueue.pending(1).map(record => record.sourceId), processing: promptQueue.processing().map(job => job.batchId) });
          if (after === fingerprint) return;
        } catch { return; }
      }
    })();
  });
  server.on('close', () => {
    closed = true;
    clearInterval(recordingTimer);
    hookStatus.close();
    lifecycle.close();
    try { Promise.resolve(transport.close?.()).catch(() => {}); }
    catch { /* Shutdown never resets source or memory state. */ }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await loadEnvironment();
    const port = process.env.PORT === undefined ? 4173 : Number(process.env.PORT);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须为 1024 到 65535 之间的整数。');
    const store = new MemoryStore({ storage: createFileStorage({ root: WORKSPACE_ROOT }) });
    const server = createPreviewServer({ store, bridgeStorage: createCaptureRequestStorage({ root: WORKSPACE_ROOT }), nativeMemoryStorage: createCodexMemoryImportStorage({ root: WORKSPACE_ROOT }),
      profileStorage: createProfileOnboardingStorage({ root: WORKSPACE_ROOT }), promptStorage: createPromptCaptureStorage({ root: WORKSPACE_ROOT }),
      contextStorage: createContextMemoryStorage({ root: WORKSPACE_ROOT }), recordingStorage: createCodexConversationRecorderStorage({ root: WORKSPACE_ROOT }), lifecycleStorage: createCodexLifecycleStorage({ root: WORKSPACE_ROOT }),
      enableConversationRecorder: true, enableProfileWorker: true, enableHookStatusProbe: true });
    server.on('error', () => { console.error('预览服务器启动失败。请检查端口是否已被使用。'); process.exitCode = 1; });
    server.listen(port, HOST, () => console.log(`MemoryUI 本机预览：http://${HOST}:${port}`));
  } catch (error) {
    console.error(error instanceof Error ? error.message : '预览服务器启动失败。');
    process.exitCode = 1;
  }
}
