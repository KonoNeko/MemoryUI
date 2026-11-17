import { createHash, randomUUID } from 'node:crypto';
import { CATEGORIES } from './memory-taxonomy.mjs';
import { createAtomicFileStorage } from './atomic-file-storage.mjs';
import { getDataDirectory } from './server-storage.mjs';
import { readStorageStatus } from './storage-status.mjs';

export const MAX_RESULT_IDS = 128;
export const PROMPT_CAPTURE_LIMITS = Object.freeze({ maxPromptChars: 16000, maxRecords: 200, maxJobs: 100, maxBatch: 20, maxResultIds: MAX_RESULT_IDS, maxBytes: 1024 * 1024 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const STATUSES = ['pending', 'processing', 'done', 'error'];
const JOB_STATUSES = ['processing', 'done', 'released', 'error'];
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(value).digest('hex');
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const topics = value => Array.isArray(value) && value.length > 0 && value.length <= CATEGORIES.length && new Set(value).size === value.length && value.every(item => CATEGORIES.includes(item));
const ids = value => Array.isArray(value) && value.length <= PROMPT_CAPTURE_LIMITS.maxBatch && new Set(value).size === value.length && value.every(id => typeof id === 'string' && id.trim() && id.length <= 100);
const resultIdsValid = value => Array.isArray(value) && value.length <= MAX_RESULT_IDS && new Set(value).size === value.length && value.every(id => typeof id === 'string' && id.trim() && id.length <= 100);
const scopeHash = categories => digest(JSON.stringify(categories));

export class PromptCaptureError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'PromptCaptureError'; this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new PromptCaptureError(code, message, status); };

// These are deliberately narrow credential indicators, not a claim that every
// possible secret can be recognized. The extraction worker must still exclude
// secrets and technical instructions rather than saving them as personal facts.
export function promptContainsCredential(prompt) {
  return /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(prompt)
    || /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/.test(prompt)
    || /\b(?:authorization\s*:\s*bearer\s+\S{8,}|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd)\s*[:=]\s*["']?[^\s"']{4,})/i.test(prompt)
    || /(?:密码|密钥|令牌)\s*(?:是|为|[:：=])\s*[^\s，。；]{4,}/.test(prompt);
}

export function normalizeCodexPromptEvent(event) {
  if (!plain(event) || event.hook_event_name !== 'UserPromptSubmit' || typeof event.prompt !== 'string' || !event.prompt.trim()
    || event.agent_id || event.agent_type
    || event.prompt.length > PROMPT_CAPTURE_LIMITS.maxPromptChars || event.prompt.includes('\0') || !IDENTIFIER.test(event.session_id ?? '')
    || (event.turn_id !== undefined && !IDENTIFIER.test(event.turn_id)) || (event.event_id !== undefined && !IDENTIFIER.test(event.event_id))
    || (event.role !== undefined && event.role !== 'user')) fail('PROMPT_CAPTURE_INVALID_EVENT', '需要有效的 Codex UserPromptSubmit 用户消息。');
  return { hook_event_name: 'UserPromptSubmit', prompt: event.prompt, session_id: event.session_id,
    ...(event.turn_id === undefined ? {} : { turn_id: event.turn_id }), ...(event.event_id === undefined ? {} : { event_id: event.event_id }) };
}

export function createPromptCaptureStorage({ root, env = process.env, directory = getDataDirectory(root, env), fileSystem }) {
  return createAtomicFileStorage({ directory, basename: 'codex-prompt-events.json', fileSystem,
    messages: { unreadable: 'Invalid prompt capture queue', tooLarge: 'Prompt capture queue exceeds storage limit', changed: 'Prompt capture queue changed outside this service' } });
}

export class PromptCaptureQueue {
  #getStore; #storage; #clock; #grantProvider;
  #state = { version: 1, records: [], jobs: [] };
  constructor({ getStore, storage = null, clock = () => Date.now(), grantProvider = () => null }) {
    if (typeof getStore !== 'function' || typeof grantProvider !== 'function') throw new TypeError('Prompt queue needs store and grant providers.');
    this.#getStore = getStore; this.#storage = storage; this.#clock = clock; this.#grantProvider = grantProvider;
  }
  #permission(client = 'codex') {
    if (client !== 'codex') fail('PROMPT_CAPTURE_CLIENT_REQUIRED', '自然对话采集只接受本机绑定的 Codex 客户端。', 403);
    const setup = this.#getStore().getAgentSetup(client), grant = this.#grantProvider(client);
    const configured = setup?.configured === true, autoCapture = configured && setup.setup?.autoCapture === true;
    const sourceApproved = plain(grant) && grant.approved === true && grant.future_current === true;
    const categories = autoCapture && sourceApproved && topics(grant.categories)
      ? CATEGORIES.filter(category => setup.setup.categories.includes(category) && grant.categories.includes(category)) : [];
    const reason = !configured ? 'not_configured' : !autoCapture ? 'auto_capture_disabled' : !sourceApproved ? 'source_not_authorized' : !categories.length ? 'no_authorized_categories' : null;
    return { allowed: reason === null, configured, autoCapture, futureCurrent: sourceApproved, categories, reason };
  }
  #load() {
    if (!this.#storage) return;
    try {
      const serialized = this.#storage.getItem('codex-prompt-events');
      if (serialized == null) { this.#state = { version: 1, records: [], jobs: [] }; return; }
      if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > PROMPT_CAPTURE_LIMITS.maxBytes) throw new Error('Oversize queue');
      const state = JSON.parse(serialized), sourceIds = new Set(), batchIds = new Set();
      if (!plain(state) || Object.keys(state).some(key => !['version', 'records', 'jobs'].includes(key)) || state.version !== 1
        || !Array.isArray(state.records) || state.records.length > PROMPT_CAPTURE_LIMITS.maxRecords || !Array.isArray(state.jobs) || state.jobs.length > PROMPT_CAPTURE_LIMITS.maxJobs) throw new Error('Invalid queue');
      for (const record of state.records) {
        if (!plain(record) || Object.keys(record).some(key => !['sourceId', 'client', 'eventName', 'sessionId', 'turnId', 'eventId', 'eventKey', 'promptSha256', 'fingerprint', 'prompt', 'categories', 'createdAt', 'status', 'batchId', 'completedAt', 'resultIds', 'errorCode'].includes(key))
          || !UUID.test(record.sourceId) || sourceIds.has(record.sourceId) || record.client !== 'codex' || record.eventName !== 'UserPromptSubmit'
          || !IDENTIFIER.test(record.sessionId) || (record.turnId !== undefined && !IDENTIFIER.test(record.turnId)) || (record.eventId !== undefined && !IDENTIFIER.test(record.eventId))
          || !HASH.test(record.eventKey) || !HASH.test(record.promptSha256) || !HASH.test(record.fingerprint) || !topics(record.categories)
          || !validDate(record.createdAt) || !STATUSES.includes(record.status) || (record.batchId !== undefined && !UUID.test(record.batchId))
          || (record.status !== 'done' && (typeof record.prompt !== 'string' || !record.prompt.trim() || record.prompt.length > PROMPT_CAPTURE_LIMITS.maxPromptChars || digest(record.prompt) !== record.promptSha256))
          || (record.status === 'done' && (record.prompt !== undefined || !resultIdsValid(record.resultIds) || !validDate(record.completedAt)))
          || (record.errorCode !== undefined && !/^[A-Z0-9_]{1,80}$/.test(record.errorCode))) throw new Error('Invalid source record');
        const eventKey = digest(JSON.stringify(['codex', 'UserPromptSubmit', record.sessionId, record.turnId ?? record.eventId ?? record.promptSha256]));
        if (record.eventKey !== eventKey || record.fingerprint !== digest(`${eventKey}:${record.promptSha256}`)) throw new Error('Invalid source fingerprint');
        sourceIds.add(record.sourceId);
      }
      for (const job of state.jobs) {
        if (!plain(job) || Object.keys(job).some(key => !['batchId', 'sourceIds', 'categories', 'scopeFingerprint', 'createdAt', 'status', 'resultIds', 'completedAt', 'errorCode'].includes(key))
          || !UUID.test(job.batchId) || batchIds.has(job.batchId) || !ids(job.sourceIds) || !job.sourceIds.length || job.sourceIds.some(id => !UUID.test(id))
          || !topics(job.categories) || job.scopeFingerprint !== scopeHash(job.categories) || !validDate(job.createdAt) || !JOB_STATUSES.includes(job.status)
          || (job.status === 'done' && (!resultIdsValid(job.resultIds) || !validDate(job.completedAt)))
          || (job.errorCode !== undefined && !/^[A-Z0-9_]{1,80}$/.test(job.errorCode))) throw new Error('Invalid capture job');
        if (job.status === 'processing' && job.sourceIds.some(id => !state.records.some(record => record.sourceId === id && record.status === 'processing' && record.batchId === job.batchId))) throw new Error('Invalid processing job');
        batchIds.add(job.batchId);
      }
      if (state.records.some(record => record.status === 'processing' && !state.jobs.some(job => job.batchId === record.batchId && job.status === 'processing' && job.sourceIds.includes(record.sourceId)))) throw new Error('Missing processing job');
      this.#state = state;
    } catch { fail('PROMPT_CAPTURE_STORAGE_INVALID', '无法读取本机对话采集队列，原数据未被重置。', 503); }
  }
  #save(next) {
    const value = JSON.stringify(next);
    if (Buffer.byteLength(value, 'utf8') > PROMPT_CAPTURE_LIMITS.maxBytes) fail('PROMPT_CAPTURE_QUEUE_FULL', '本机对话采集队列已满，请先处理已有消息。', 409);
    try { this.#storage?.setItem('codex-prompt-events', value); }
    catch { fail('PROMPT_CAPTURE_STORAGE_UNAVAILABLE', '无法保存本机对话采集队列，没有直接写入个人记忆。', 503); }
    this.#state = next;
  }
  #job(batchId) {
    if (typeof batchId !== 'string' || !UUID.test(batchId)) fail('PROMPT_CAPTURE_INVALID_JOB', '需要有效的对话采集任务编号。');
    const job = this.#state.jobs.find(job => job.batchId === batchId);
    if (!job) fail('PROMPT_CAPTURE_JOB_NOT_FOUND', '找不到此对话采集任务。', 404);
    return job;
  }
  #view(job) {
    return { batchId: job.batchId, status: job.status, scope: 'future_current', client: 'codex', categories: [...job.categories], createdAt: job.createdAt,
      sourceIds: [...job.sourceIds], sources: job.status === 'processing' ? job.sourceIds.map(id => {
        const record = this.#state.records.find(record => record.sourceId === id);
        return { sourceId: record.sourceId, fingerprint: record.fingerprint, content: record.prompt, sessionId: record.sessionId,
          ...(record.turnId === undefined ? {} : { turnId: record.turnId }), createdAt: record.createdAt, categories: [...job.categories] };
      }) : [], ...(job.resultIds ? { resultIds: [...job.resultIds] } : {}), ...(job.completedAt ? { completedAt: job.completedAt } : {}) };
  }
  enqueue({ client, event }) {
    const permission = this.#permission(client);
    if (!permission.allowed) return { accepted: false, duplicate: false, reason: permission.reason };
    const normalized = normalizeCodexPromptEvent(event);
    if (promptContainsCredential(normalized.prompt)) return { accepted: false, duplicate: false, reason: 'credential_detected' };
    if (/(?:不要|不许|别)(?:把.{0,12})?(?:记住|保存|记录|入库)|do not (?:remember|save|store)|don['’]t (?:remember|save|store)/i.test(normalized.prompt)) return { accepted: false, duplicate: false, reason: 'user_excluded' };
    this.#load();
    const promptSha256 = digest(normalized.prompt), eventKey = digest(JSON.stringify(['codex', 'UserPromptSubmit', normalized.session_id, normalized.turn_id ?? normalized.event_id ?? promptSha256]));
    const fingerprint = digest(`${eventKey}:${promptSha256}`), duplicate = this.#state.records.find(record => record.eventKey === eventKey);
    if (duplicate) {
      if (duplicate.fingerprint !== fingerprint) fail('PROMPT_CAPTURE_EVENT_CONFLICT', '同一用户消息事件出现不同正文，未覆盖已采集原话。', 409);
      return { accepted: true, duplicate: true, sourceId: duplicate.sourceId, fingerprint, status: duplicate.status };
    }
    const next = clone(this.#state);
    while (next.records.length >= PROMPT_CAPTURE_LIMITS.maxRecords) {
      const index = next.records.findIndex(record => record.status === 'done');
      if (index < 0) fail('PROMPT_CAPTURE_QUEUE_FULL', '本机对话采集队列已满，已有消息未被丢弃。', 409);
      next.records.splice(index, 1);
    }
    const record = { sourceId: randomUUID(), client: 'codex', eventName: 'UserPromptSubmit', sessionId: normalized.session_id,
      ...(normalized.turn_id === undefined ? {} : { turnId: normalized.turn_id }), ...(normalized.event_id === undefined ? {} : { eventId: normalized.event_id }),
      eventKey, promptSha256, fingerprint, prompt: normalized.prompt, categories: permission.categories, createdAt: new Date(this.#clock()).toISOString(), status: 'pending' };
    next.records.push(record); this.#save(next);
    return { accepted: true, duplicate: false, sourceId: record.sourceId, fingerprint, status: 'pending' };
  }
  pending(limit = PROMPT_CAPTURE_LIMITS.maxBatch) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROMPT_CAPTURE_LIMITS.maxBatch) fail('PROMPT_CAPTURE_INVALID_LIMIT', '每批只能读取1至20条待处理消息。');
    const permission = this.#permission();
    if (!permission.allowed) return [];
    this.#load();
    return this.#state.records.filter(record => record.status === 'pending' && record.categories.some(category => permission.categories.includes(category))).slice(0, limit)
      .map(record => ({ sourceId: record.sourceId, fingerprint: record.fingerprint, createdAt: record.createdAt, categories: record.categories.filter(category => permission.categories.includes(category)) }));
  }
  processing() {
    const permission = this.#permission();
    if (!permission.allowed) return [];
    this.#load();
    // An old job remains frozen under its original grant. Discovery must not
    // offer it to a worker after only part of that scope is still authorized;
    // leave it untouched and allow currently authorized pending work through.
    return this.#state.jobs.filter(job => job.status === 'processing' && job.categories.every(category => permission.categories.includes(category)))
      .map(job => ({ batchId: job.batchId, sourceIds: [...job.sourceIds], categories: [...job.categories] }));
  }
  getForJob(sourceIds) {
    if (!ids(sourceIds) || !sourceIds.length || sourceIds.some(id => !UUID.test(id))) fail('PROMPT_CAPTURE_INVALID_SOURCES', '需要1至20个不重复的实际消息来源编号。');
    const permission = this.#permission();
    if (!permission.allowed) fail('PROMPT_CAPTURE_NOT_AUTHORIZED', '当前没有后续 Codex 用户对话采集授权。', 403);
    this.#load();
    const records = sourceIds.map(id => this.#state.records.find(record => record.sourceId === id));
    if (records.some(record => !record)) fail('PROMPT_CAPTURE_SOURCE_NOT_FOUND', '找不到此消息来源。', 404);
    const categories = permission.categories.filter(category => records.every(record => record.categories.includes(category)));
    if (!categories.length) fail('PROMPT_CAPTURE_SCOPE_CHANGED', '这些消息没有共同的当前授权主题。', 409);
    const existing = this.#state.jobs.find(job => ['processing', 'done'].includes(job.status) && job.sourceIds.length === sourceIds.length && job.sourceIds.every(id => sourceIds.includes(id)));
    if (existing) {
      if (existing.scopeFingerprint !== scopeHash(categories)) fail('PROMPT_CAPTURE_SCOPE_CHANGED', '任务的主题授权已变化，请先核对已有保存回执。', 409);
      return this.#view(existing);
    }
    if (records.some(record => record.status !== 'pending')) fail('PROMPT_CAPTURE_SOURCE_BUSY', '消息已被其他任务处理，不自动重复提交。', 409);
    const next = clone(this.#state);
    while (next.jobs.length >= PROMPT_CAPTURE_LIMITS.maxJobs) {
      const index = next.jobs.findIndex(job => job.status !== 'processing');
      if (index < 0) fail('PROMPT_CAPTURE_QUEUE_FULL', '采集任务已满，请先完成已有任务。', 409);
      next.jobs.splice(index, 1);
    }
    const job = { batchId: randomUUID(), sourceIds: [...sourceIds], categories, scopeFingerprint: scopeHash(categories), createdAt: new Date(this.#clock()).toISOString(), status: 'processing' };
    next.jobs.push(job);
    for (const record of next.records.filter(record => sourceIds.includes(record.sourceId))) { record.status = 'processing'; record.batchId = job.batchId; delete record.errorCode; }
    this.#save(next); return this.#view(job);
  }
  getJob(batchId) {
    if (!this.#permission().allowed) fail('PROMPT_CAPTURE_NOT_AUTHORIZED', '当前没有后续 Codex 用户对话采集授权。', 403);
    this.#load(); const job = this.#job(batchId);
    const current = this.#permission().categories;
    if (job.categories.some(category => !current.includes(category))) fail('PROMPT_CAPTURE_SCOPE_CHANGED', '当前主题授权已缩小，不能再读取冻结原话。', 403);
    return this.#view(job);
  }
  ack(batchId, resultIds) {
    if (!resultIdsValid(resultIds)) fail('PROMPT_CAPTURE_INVALID_RESULTS', '完成回执只接受最多128个不重复的实际记忆编号。');
    this.#load(); const job = this.#job(batchId);
    if (job.status === 'done') {
      if (JSON.stringify(job.resultIds) !== JSON.stringify(resultIds)) fail('PROMPT_CAPTURE_ACK_CONFLICT', '此任务已经记录另一份保存回执。', 409);
      return this.#view(job);
    }
    if (job.status !== 'processing') fail('PROMPT_CAPTURE_JOB_NOT_PROCESSING', '此任务不在处理中，不能确认另一轮结果。', 409);
    const next = clone(this.#state), target = next.jobs.find(item => item.batchId === batchId), at = new Date(this.#clock()).toISOString();
    target.status = 'done'; target.resultIds = [...resultIds]; target.completedAt = at;
    for (const record of next.records.filter(record => job.sourceIds.includes(record.sourceId))) {
      record.status = 'done'; record.resultIds = [...resultIds]; record.completedAt = at; delete record.prompt;
    }
    this.#save(next); return this.#view(target);
  }
  fail(batchId, { retryable = false, code = 'PROCESSING_FAILED' } = {}) {
    if (typeof retryable !== 'boolean' || typeof code !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(code)) fail('PROMPT_CAPTURE_INVALID_FAILURE', '采集失败状态无效。');
    this.#load(); const job = this.#job(batchId);
    if (job.status === 'done') fail('PROMPT_CAPTURE_ALREADY_DONE', '已完成任务不能重新排队。', 409);
    // Retrying an error is an explicit trusted-worker decision, never a lease
    // timeout. The caller must first resolve any uncertain memory commit.
    if (job.status !== 'processing' && !(job.status === 'error' && retryable)) return this.#view(job);
    const next = clone(this.#state), target = next.jobs.find(item => item.batchId === batchId);
    target.status = retryable ? 'released' : 'error'; target.errorCode = code;
    for (const record of next.records.filter(record => job.sourceIds.includes(record.sourceId))) {
      record.status = retryable ? 'pending' : 'error'; record.errorCode = code; delete record.batchId;
    }
    this.#save(next); return this.#view(target);
  }
  release(batchId) { return this.fail(batchId, { retryable: true, code: 'RELEASED_BEFORE_COMMIT' }); }
  permission() { return this.#permission(); }
  status() {
    const permission = this.#permission(); this.#load();
    const counts = Object.fromEntries(STATUSES.map(status => [status, this.#state.records.filter(record => record.status === status).length]));
    return { ...permission, counts, total: this.#state.records.length, activeJobs: this.#state.jobs.filter(job => job.status === 'processing').length, limits: { ...PROMPT_CAPTURE_LIMITS }, storage: readStorageStatus(this.#storage) };
  }
}
