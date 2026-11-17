import { randomUUID } from 'node:crypto';
import { createAtomicFileStorage } from './atomic-file-storage.mjs';
import { getDataDirectory } from './server-storage.mjs';

export const CODEX_RECORDER_LIMITS = Object.freeze({ maxSubscriptions: 20, maxTurns: 200, maxTurnPages: 4,
  turnPageSize: 50, maxItemPages: 8, itemPageSize: 100, maxMessageChars: 16000, maxBatchMessages: 200,
  maxBatchBytes: 120 * 1024, maxLegacyResponseBytes: 16 * 1024 * 1024, maxIssues: 50 });
const KEY = 'codex-conversation-recorder';
const TERMINAL = ['completed', 'interrupted', 'failed'];
const clone = value => JSON.parse(JSON.stringify(value));
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const identifier = value => typeof value === 'string' && Boolean(value.trim()) && value.length <= 200 && !/[\x00-\x1f]/.test(value);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const unsupported = error => [-32601, 'METHOD_NOT_FOUND', 'UNSUPPORTED_METHOD'].includes(error?.code);
const empty = () => ({ version: 1, subscriptions: [] });

export class CodexConversationRecorderError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CodexConversationRecorderError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 400) { throw new CodexConversationRecorderError(code, message, status); }
function exact(value, fields, required = fields) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => !fields.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) fail('CODEX_RECORDER_INVALID_ARGUMENT', '对话记录参数包含未知字段或缺少必要字段。');
}
function list(value, max) {
  return Array.isArray(value) && value.length <= max && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => index).every(index => Object.hasOwn(value, index));
}
function isExcluded(value) {
  const source = typeof value?.source === 'string' ? value.source : JSON.stringify(value?.source ?? value?.sourceKind ?? '');
  return value?.synthetic === true || value?.isSynthetic === true || value?.isTest === true || value?.test === true
    || Boolean(value?.subagentId) || /sub.?agent|synthetic|simulation|(?:^|\W)test(?:$|\W)/i.test(source);
}
function issue(report, code, details = {}) {
  if (report.length < CODEX_RECORDER_LIMITS.maxIssues) report.push({ code, ...details });
}
function cursor(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value || value.length > 8192) fail('CODEX_RECORDER_INVALID_RESPONSE', 'Codex 返回了无效的分页标记。', 503);
  return value;
}
function timestamp(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
}
function completed(item, wrapper, turn) {
  return turn.status === 'completed'
    || typeof (item.completedAtMs ?? wrapper.completedAtMs) === 'number'
      && Number.isFinite(item.completedAtMs ?? wrapper.completedAtMs);
}
export function visibleCodexUserText(text) {
  const authored = text.replace(/<send_user_message_question_reply(?:\s[^>]*)?>([\s\S]*?)<\/send_user_message_question_reply>/gi, (original, encoded) => {
    try {
      const entries = JSON.parse(encoded);
      return Array.isArray(entries) && entries.every(entry => plain(entry) && typeof entry.answer === 'string')
        ? entries.map(entry => entry.answer).join('\n') : original;
    } catch { return original; }
  });
  // App-server represents these host-generated attachments as user items.
  // Remove known metadata wrappers while preserving genuine plain text exactly.
  const filtered = authored.replace(/<(environment_context|external_codex_apps_[\w-]+|turn_aborted)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, '');
  return filtered === authored ? authored : filtered.trim();
}

function normalizeItem(value, turn, report) {
  const wrapper = plain(value?.item) ? value : {};
  const item = wrapper.item ?? value;
  if (!plain(item) || !identifier(item.id) || isExcluded(item) || isExcluded(wrapper)) return null;
  let role, content;
  if (item.type === 'userMessage' && (item.role === undefined || item.role === 'user')) {
    if (!Array.isArray(item.content)) return null;
    const text = item.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
    content = visibleCodexUserText(text);
    role = 'user';
  } else if (item.type === 'agentMessage' && (item.role === undefined || item.role === 'assistant') && completed(item, wrapper, turn)) {
    content = item.text;
    role = 'assistant';
  } else return null;
  if (typeof content !== 'string' || !content.trim()) return null;
  if (content.length > CODEX_RECORDER_LIMITS.maxMessageChars) {
    issue(report.issues, 'MESSAGE_TOO_LONG', { turnId: turn.id, itemId: item.id, characters: content.length });
    report.skipped++;
    return null;
  }
  const at = timestamp(item.startedAtMs ?? wrapper.startedAtMs);
  return { id: item.id, role, content, ...(at ? { at } : {}) };
}

function validateState(state) {
  exact(state, ['version', 'subscriptions']);
  if (state.version !== 1 || !list(state.subscriptions, CODEX_RECORDER_LIMITS.maxSubscriptions)) throw new Error('Invalid recorder state');
  const seen = new Set();
  for (const subscription of state.subscriptions) {
    const required = ['threadId', 'projectId', 'enabled', 'generation', 'createdAt', 'updatedAt', 'lastSyncAt', 'lastSuccessAt', 'recordedMessages', 'skippedMessages', 'issues', 'error', 'turns'];
    exact(subscription, [...required, 'autoProjectMemoryId', 'projectArchivedAt', 'automatic'], required);
    if (!identifier(subscription.threadId) || seen.has(subscription.threadId) || subscription.projectId !== null && !identifier(subscription.projectId)
      || typeof subscription.enabled !== 'boolean' || !identifier(subscription.generation)
      || subscription.automatic !== undefined && typeof subscription.automatic !== 'boolean'
      || !validTime(subscription.createdAt) || !validTime(subscription.updatedAt)
      || subscription.lastSyncAt !== null && !validTime(subscription.lastSyncAt)
      || subscription.lastSuccessAt !== null && !validTime(subscription.lastSuccessAt)
      || !Number.isSafeInteger(subscription.recordedMessages) || subscription.recordedMessages < 0
      || !Number.isSafeInteger(subscription.skippedMessages) || subscription.skippedMessages < 0
      || !list(subscription.issues, CODEX_RECORDER_LIMITS.maxIssues) || !list(subscription.turns, CODEX_RECORDER_LIMITS.maxTurns)
      || subscription.autoProjectMemoryId !== undefined && !identifier(subscription.autoProjectMemoryId)
      || subscription.projectArchivedAt !== undefined && !validTime(subscription.projectArchivedAt)) throw new Error('Invalid recorder subscription');
    if (subscription.error !== null) {
      exact(subscription.error, ['code', 'message']);
      if (!/^[A-Z0-9_]{1,100}$/.test(subscription.error.code) || typeof subscription.error.message !== 'string' || subscription.error.message.length > 300) throw new Error('Invalid recorder error');
    }
    for (const entry of subscription.issues) {
      exact(entry, ['code', 'turnId', 'itemId', 'characters', 'count'], ['code']);
      if (!/^[A-Z0-9_]{1,100}$/.test(entry.code)
        || entry.turnId !== undefined && !identifier(entry.turnId) || entry.itemId !== undefined && !identifier(entry.itemId)
        || entry.characters !== undefined && (!Number.isSafeInteger(entry.characters) || entry.characters < 0)
        || entry.count !== undefined && (!Number.isSafeInteger(entry.count) || entry.count < 0)) throw new Error('Invalid recorder issue');
    }
    const turnIds = new Set();
    for (const turn of subscription.turns) {
      exact(turn, ['turnId', 'cursor', 'complete', 'status']);
      if (!identifier(turn.turnId) || turnIds.has(turn.turnId) || typeof turn.complete !== 'boolean'
        || typeof turn.status !== 'string' || turn.status.length > 40) throw new Error('Invalid turn checkpoint');
      cursor(turn.cursor);
      turnIds.add(turn.turnId);
    }
    seen.add(subscription.threadId);
  }
  return state;
}

export function createCodexConversationRecorderStorage({ root, env = process.env, directory = getDataDirectory(root, env), fileSystem }) {
  return createAtomicFileStorage({ directory, basename: 'codex-conversation-recorder.json', createDirectory: true, fileSystem,
    messages: { unreadable: 'Invalid Codex recorder file', tooLarge: 'Codex recorder exceeds storage limit', changed: 'Codex recorder changed outside this service' } });
}

export class CodexConversationRecorder {
  #transport;
  #getContextMemory;
  #storage;
  #clock;
  #state = empty();
  #flight = null;
  #unsupported = new Set();
  #automaticPermission;

  constructor({ transport, getContextMemory, storage = null, clock = () => Date.now(), automaticPermission = () => true } = {}) {
    if (typeof getContextMemory !== 'function') throw new TypeError('Codex recorder needs a context memory provider.');
    this.#transport = transport;
    this.#getContextMemory = getContextMemory;
    this.#storage = storage;
    this.#clock = clock;
    if (typeof automaticPermission !== 'function') throw new TypeError('Automatic recording needs a permission provider.');
    this.#automaticPermission = automaticPermission;
  }

  #load() {
    if (!this.#storage) return;
    try {
      const serialized = this.#storage.getItem(KEY);
      this.#state = serialized == null ? empty() : validateState(JSON.parse(serialized));
    } catch { fail('CODEX_RECORDER_STORAGE_INVALID', '无法读取 Codex 对话记录设置，请检查存储状态。', 503); }
  }
  #save(next) {
    validateState(next);
    try { this.#storage?.setItem(KEY, JSON.stringify(next)); }
    catch { fail('CODEX_RECORDER_STORAGE_UNAVAILABLE', 'Codex 对话记录设置保存失败，请重试。', 503); }
    this.#state = next;
  }
  #now() { return new Date(this.#clock()).toISOString(); }
  #allowed(subscription) {
    if (!subscription.automatic) return true;
    try { return this.#automaticPermission() === true; } catch { return false; }
  }
  #current(subscription) {
    this.#load();
    return this.#state.subscriptions.find(item => item.threadId === subscription.threadId && item.generation === subscription.generation && item.enabled && this.#allowed(item));
  }
  #update(subscription, patch) {
    if (!this.#current(subscription)) return false;
    const next = clone(this.#state);
    Object.assign(next.subscriptions.find(item => item.threadId === subscription.threadId), patch);
    this.#save(next);
    return true;
  }

  status() {
    this.#load();
    return { source: 'codex-app-server', available: typeof this.#transport?.request === 'function', running: this.#flight !== null,
      subscriptions: this.#state.subscriptions.map(({ generation, turns, ...subscription }) => ({ ...clone(subscription),
        ...(subscription.automatic ? { permissionPaused: !this.#allowed(subscription) } : {}),
        lastSyncedAt: subscription.lastSyncAt, lastError: subscription.error?.message ?? null, savedCount: subscription.recordedMessages,
        pendingBackfill: turns.some(turn => !turn.complete), trackedTurns: turns.length })) };
  }

  startAutomatic(input) {
    this.#load();
    if (this.#state.subscriptions.some(item => item.threadId === input?.threadId)) return this.status();
    return this.start(input, { automatic: true });
  }

  start(input, { automatic = false } = {}) {
    exact(input, ['threadId', 'projectId', 'consent'], ['threadId', 'consent']);
    if (!identifier(input.threadId) || input.projectId !== undefined && !identifier(input.projectId)) fail('CODEX_RECORDER_INVALID_ARGUMENT', '请选择有效的当前对话和项目编号。');
    if (input.consent !== true) fail('CODEX_RECORDER_CONSENT_REQUIRED', '记录当前可见对话前需要明确授权。', 403);
    this.#load();
    const projectId = input.projectId ?? null;
    const existing = this.#state.subscriptions.find(item => item.threadId === input.threadId);
    const saved = this.#getContextMemory().getSnapshot().conversations.find(item => item.client === 'codex' && item.conversationId === input.threadId);
    if (saved && saved.projectId !== projectId || existing && existing.projectId !== projectId) fail('CODEX_RECORDER_SCOPE_CONFLICT', '这个对话已绑定其他项目范围，请沿用原项目。', 409);
    if (existing?.enabled && (!existing.automatic || automatic)) return this.status();
    if (!existing && this.#state.subscriptions.length >= CODEX_RECORDER_LIMITS.maxSubscriptions) fail('CODEX_RECORDER_SUBSCRIPTION_LIMIT', '最多同时保留 20 个已选择对话的记录设置。');
    const now = this.#now(), next = clone(this.#state);
    if (existing) Object.assign(next.subscriptions.find(item => item.threadId === input.threadId), { enabled: true, automatic, generation: randomUUID(), updatedAt: now, error: null });
    else next.subscriptions.push({ threadId: input.threadId, projectId, enabled: true, generation: randomUUID(), createdAt: now, updatedAt: now,
      ...(automatic ? { automatic: true } : {}), lastSyncAt: null, lastSuccessAt: null, recordedMessages: saved?.messages.length ?? 0, skippedMessages: 0, issues: [], error: null, turns: [] });
    this.#save(next);
    return this.status();
  }

  stop(input) {
    exact(input, ['threadId']);
    if (!identifier(input.threadId)) fail('CODEX_RECORDER_INVALID_ARGUMENT', '对话编号无效。');
    this.#load();
    const next = clone(this.#state), subscription = next.subscriptions.find(item => item.threadId === input.threadId);
    if (subscription?.enabled) {
      Object.assign(subscription, { enabled: false, generation: randomUUID(), updatedAt: this.#now() });
      this.#save(next);
    }
    return this.status();
  }

  async #request(method, params) {
    if (typeof this.#transport?.request !== 'function') fail('CODEX_RECORDER_UNAVAILABLE', '本机 Codex 对话读取通道尚不可用。', 503);
    this.#load();
    if (!this.#state.subscriptions.some(item => item.enabled && item.threadId === params.threadId && this.#allowed(item))) fail('CODEX_RECORDER_STOPPED', '所选对话记录已暂停。', 409);
    return this.#transport.request(method, params);
  }

  async #legacy(threadId, cache, issues) {
    if (!cache.legacy) {
      const response = await this.#request('thread/read', { threadId, includeTurns: true });
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > CODEX_RECORDER_LIMITS.maxLegacyResponseBytes
        || response?.thread?.id !== threadId || !Array.isArray(response.thread.turns) || isExcluded(response.thread)) fail('CODEX_RECORDER_INVALID_RESPONSE', 'Codex 历史返回范围或大小无效。', 503);
      cache.legacy = response.thread;
      issue(issues, 'LEGACY_READ_FALLBACK');
      if (response.thread.turns.length > CODEX_RECORDER_LIMITS.maxTurns) issue(issues, 'TURN_HISTORY_LIMIT', { count: response.thread.turns.length - CODEX_RECORDER_LIMITS.maxTurns });
    }
    return cache.legacy;
  }

  async #turns(threadId, cache, issues) {
    if (this.#unsupported.has('thread/turns/list')) return (await this.#legacy(threadId, cache, issues)).turns.slice(-CODEX_RECORDER_LIMITS.maxTurns).reverse();
    const turns = [], seen = new Set();
    let nextCursor = null;
    try {
      for (let page = 0; page < CODEX_RECORDER_LIMITS.maxTurnPages; page++) {
        const response = await this.#request('thread/turns/list', { threadId, limit: CODEX_RECORDER_LIMITS.turnPageSize, ...(nextCursor ? { cursor: nextCursor } : {}) });
        if (!Array.isArray(response?.data) || response.data.length > CODEX_RECORDER_LIMITS.turnPageSize) fail('CODEX_RECORDER_INVALID_RESPONSE', 'Codex 对话轮次分页无效。', 503);
        for (const turn of response.data) {
          if (!identifier(turn?.id) || seen.has(turn.id)) continue;
          seen.add(turn.id);
          if (!isExcluded(turn)) turns.push(turn);
        }
        const previous = nextCursor;
        nextCursor = cursor(response.nextCursor);
        if (!nextCursor) return turns;
        if (nextCursor === previous) { issue(issues, 'TURN_CURSOR_REPEATED'); return turns; }
      }
      if (nextCursor) issue(issues, 'TURN_HISTORY_LIMIT');
      return turns;
    } catch (error) {
      if (!unsupported(error)) throw error;
      this.#unsupported.add('thread/turns/list');
      return (await this.#legacy(threadId, cache, issues)).turns.slice(-CODEX_RECORDER_LIMITS.maxTurns).reverse();
    }
  }

  async #items(subscription, turn, checkpoint, cache, issues) {
    if (this.#unsupported.has('thread/items/list')) {
      const thread = await this.#legacy(subscription.threadId, cache, issues);
      const source = thread.turns.find(item => item.id === turn.id);
      if (!Array.isArray(source?.items)) fail('CODEX_RECORDER_INVALID_RESPONSE', 'Codex 返回的消息列表不可用。', 503);
      return { items: source.items, cursor: null, complete: true };
    }
    let inputCursor = checkpoint?.cursor ?? null;
    const items = [];
    try {
      for (let page = 0; page < CODEX_RECORDER_LIMITS.maxItemPages; page++) {
        const response = await this.#request('thread/items/list', { threadId: subscription.threadId, turnId: turn.id,
          limit: CODEX_RECORDER_LIMITS.itemPageSize, ...(inputCursor ? { cursor: inputCursor } : {}) });
        if (!Array.isArray(response?.data) || response.data.length > CODEX_RECORDER_LIMITS.itemPageSize) fail('CODEX_RECORDER_INVALID_RESPONSE', 'Codex 消息分页无效。', 503);
        if (response.data.some(item => plain(item?.item) && item.turnId !== undefined && item.turnId !== turn.id)) fail('CODEX_RECORDER_INVALID_RESPONSE', 'Codex 消息来源轮次不匹配。', 503);
        items.push(...response.data);
        const next = cursor(response.nextCursor);
        if (!next) return { items, cursor: inputCursor, complete: true };
        if (next === inputCursor) fail('CODEX_RECORDER_INVALID_RESPONSE', 'Codex 消息分页标记没有前进。', 503);
        inputCursor = next;
      }
      issue(issues, 'ITEMS_BACKFILL_PENDING', { turnId: turn.id });
      return { items, cursor: inputCursor, complete: false };
    } catch (error) {
      if (!unsupported(error)) throw error;
      this.#unsupported.add('thread/items/list');
      return this.#items(subscription, turn, checkpoint, cache, issues);
    }
  }

  #saveMessages(subscription, messages, report) {
    const memory = this.#getContextMemory();
    const known = memory.getSnapshot().conversations.find(item => item.client === 'codex' && item.conversationId === subscription.threadId);
    if (known && known.projectId !== subscription.projectId) fail('CODEX_RECORDER_SCOPE_CONFLICT', '已保存的对话属于其他项目范围。', 409);
    const existing = new Map((known?.messages ?? []).map(item => [item.id, item]));
    const additions = [];
    for (const message of messages) {
      const previous = existing.get(message.id);
      if (previous) {
        if (previous.role !== message.role || previous.content !== message.content) {
          report.skipped++;
          issue(report.issues, 'IMMUTABLE_MESSAGE_CHANGED', { itemId: message.id });
        }
      } else {
        existing.set(message.id, message);
        additions.push(message);
      }
    }
    const base = { conversationId: subscription.threadId, ...(subscription.projectId === null ? {} : { projectId: subscription.projectId }) };
    let batch = [];
    const flush = () => {
      if (!batch.length || !this.#current(subscription)) return;
      memory.saveConversation('codex', { ...base, messages: batch });
      batch = [];
    };
    for (const message of additions) {
      const candidate = [...batch, message];
      if (candidate.length > CODEX_RECORDER_LIMITS.maxBatchMessages
        || Buffer.byteLength(JSON.stringify({ ...base, messages: candidate }), 'utf8') > CODEX_RECORDER_LIMITS.maxBatchBytes) flush();
      batch.push(message);
    }
    flush();
    return memory.getSnapshot().conversations.find(item => item.client === 'codex' && item.conversationId === subscription.threadId)?.messages.length ?? 0;
  }

  #archiveProjectProgress(subscription, report) {
    if (subscription.projectId === null || !this.#current(subscription)) return null;
    const memory = this.#getContextMemory();
    const conversation = memory.getSnapshot().conversations.find(item => item.client === 'codex' && item.projectId === subscription.projectId && item.conversationId === subscription.threadId);
    if (!conversation) return null;
    const header = '自动项目进展参考\n以下按原文摘录最近的完整消息，保留发言者与来源。\n\n';
    const selected = [];
    let characters = header.length;
    // Reserve room for the coverage receipt. Each selected source remains whole.
    for (const message of [...conversation.messages].reverse()) {
      const excerpt = `${message.role === 'user' ? '用户' : '助手'} [${message.id}]\n${message.content}`;
      if (selected.length >= 100) break;
      if (characters + excerpt.length + 2 > 3920) continue;
      selected.unshift({ id: message.id, excerpt });
      characters += excerpt.length + 2;
    }
    if (!selected.length) {
      issue(report.issues, 'PROJECT_ARCHIVE_NO_FITTING_MESSAGE');
      return null;
    }
    const footer = `\n\n摘录 ${selected.length} 条，另有 ${conversation.messages.length - selected.length} 条保留在原对话。`;
    const result = memory.saveAutomaticProjectProgress('codex', { projectId: subscription.projectId,
      conversationId: subscription.threadId, content: header + selected.map(item => item.excerpt).join('\n\n') + footer,
      messageIds: selected.map(item => item.id) });
    return { autoProjectMemoryId: result.memory.id, projectArchivedAt: this.#now() };
  }

  async #syncThread(subscription) {
    const report = { issues: [], skipped: 0 };
    try {
      const metadata = await this.#request('thread/read', { threadId: subscription.threadId, includeTurns: false });
      if (metadata?.thread?.id !== subscription.threadId || isExcluded(metadata.thread)) fail('CODEX_RECORDER_THREAD_EXCLUDED', '所选对话来源不可用于当前对话记录。', 403);
      const cache = {};
      const turns = await this.#turns(subscription.threadId, cache, report.issues);
      for (const turn of [...turns].reverse()) {
        const current = this.#current(subscription);
        if (!current) return;
        const checkpoint = current.turns.find(item => item.turnId === turn.id);
        if (checkpoint?.complete && checkpoint.status === turn.status && TERMINAL.includes(turn.status) && turn.id !== turns[0]?.id) continue;
        const page = await this.#items(subscription, turn, checkpoint, cache, report.issues);
        if (!this.#current(subscription)) return;
        const messages = page.items.map(item => normalizeItem(item, turn, report)).filter(Boolean);
        const savedCount = this.#saveMessages(subscription, messages, report);
        const archive = this.#archiveProjectProgress(subscription, report);
        const latest = this.#current(subscription);
        if (!latest) return;
        const checkpoints = latest.turns.filter(item => item.turnId !== turn.id);
        checkpoints.push({ turnId: turn.id, cursor: page.cursor, complete: page.complete, status: typeof turn.status === 'string' ? turn.status : 'unknown' });
        if (!this.#update(subscription, { turns: checkpoints.slice(-CODEX_RECORDER_LIMITS.maxTurns), recordedMessages: savedCount, ...(archive ?? {}) })) return;
      }
      const now = this.#now();
      this.#update(subscription, { lastSyncAt: now, lastSuccessAt: now, skippedMessages: report.skipped, issues: report.issues, error: null });
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'CODEX_RECORDER_SYNC_FAILED';
      this.#update(subscription, { lastSyncAt: this.#now(), skippedMessages: report.skipped, issues: report.issues,
        error: { code, message: '本次 Codex 对话同步未完成，请检查连接后重试。' } });
    }
  }

  async syncAfterCurrent() {
    // Lifecycle events can arrive after an existing poll took its snapshot.
    // Wait for it, then read once more using the latest subscription/items.
    if (this.#flight) await this.#flight;
    return this.sync();
  }

  async sync() {
    if (this.#flight) { await this.#flight; return this.status(); }
    this.#load();
    const subscriptions = clone(this.#state.subscriptions.filter(item => item.enabled && this.#allowed(item)));
    this.#flight = (async () => {
      for (const subscription of subscriptions) await this.#syncThread(subscription);
    })();
    try { await this.#flight; }
    finally { this.#flight = null; }
    return this.status();
  }
}
