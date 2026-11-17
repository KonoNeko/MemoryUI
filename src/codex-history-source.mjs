import { createHash } from 'node:crypto';
import path from 'node:path';
import { visibleCodexUserText } from './codex-conversation-recorder.mjs';

export const CODEX_HISTORY_LIMITS = Object.freeze({ maxThreadPages: 8, pageSize: 50, maxReadThreads: 40, maxTurnsPerThread: 200, maxItemPages: 8, maxSources: 240, maxMessageChars: 12000, maxSourceChars: 120000 });
const digest = value => createHash('sha256').update(value).digest('hex');
const time = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);
const milliseconds = value => typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? value : null;
const sameWorkspace = (left, right) => typeof left === 'string' && (process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right));
const sourceType = thread => typeof thread?.source === 'string' ? thread.source : typeof thread?.sourceKind === 'string' ? thread.sourceKind : JSON.stringify(thread?.source ?? {});
const excluded = value => value?.synthetic === true || value?.isSynthetic === true || value?.isTest === true || value?.test === true
  || /sub.?agent|synthetic|simulation|test/i.test(sourceType(value)) || Boolean(value?.subagentId);
const methodUnavailable = error => [-32601, 'METHOD_NOT_FOUND', 'UNSUPPORTED_METHOD'].includes(error?.code);

export class CodexHistorySourceError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'CodexHistorySourceError'; this.code = code; this.status = status; }
}
const fail = (message, code = 'CODEX_HISTORY_VALIDATION_ERROR', status = 400) => { throw new CodexHistorySourceError(code, message, status); };
function validate(input, consent = true) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => !['client', 'consent', 'days', 'workspace', 'currentThreadId', 'mode'].includes(key))) fail('历史来源参数无效。');
  if (input.client !== 'codex') fail('此历史来源仅适用于 Codex。', 'CODEX_HISTORY_CLIENT_REQUIRED', 403);
  if (consent && input.consent !== true) fail('读取历史正文前需要明确授权。', 'CODEX_HISTORY_CONSENT_REQUIRED', 403);
  if (!Number.isInteger(input.days ?? 90) || (input.days ?? 90) < 1 || (input.days ?? 90) > 365) fail('历史范围需要 1–365 天。');
  if ((input.workspace ?? 'all') !== 'all' && (typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace))) fail('工作区只能是 all 或用户选择的绝对路径。');
  if (input.mode !== undefined && !['history', 'current'].includes(input.mode)) fail('历史来源模式无效。');
  if (input.currentThreadId !== undefined && !identifier(input.currentThreadId)) fail('当前对话编号无效。');
}

// The transport is the official read-only app-server protocol. This adapter
// never opens rollout JSONL, SQLite, auth, session, or configuration files.
export class CodexHistorySource {
  #transport;
  #clock;
  constructor({ transport, clock = () => Date.now() } = {}) { this.#transport = transport; this.#clock = clock; }
  get available() { return typeof this.#transport?.request === 'function'; }
  async #methods() {
    const value = typeof this.#transport?.capabilities === 'function' ? await this.#transport.capabilities() : this.#transport?.capabilities;
    return new Set(Array.isArray(value) ? value : ['thread/list', 'thread/read']);
  }
  async #request(method, params) {
    if (!this.available) fail('本机 Codex 历史读取通道尚不可用。', 'CODEX_HISTORY_UNAVAILABLE', 503);
    return this.#transport.request(method, params);
  }
  #metadata(thread) {
    if (!identifier(thread?.id)) return null;
    return { id: thread.id, ...(typeof thread.cwd === 'string' ? { workspace: thread.cwd } : {}),
      createdAt: time(thread.createdAt) === null ? null : new Date(time(thread.createdAt)).toISOString(),
      updatedAt: time(thread.updatedAt) === null ? null : new Date(time(thread.updatedAt)).toISOString(), source: sourceType(thread), excluded: excluded(thread) };
  }
  async metadata({ client = 'codex' } = {}) {
    if (client !== 'codex') fail('此历史来源仅适用于 Codex。', 'CODEX_HISTORY_CLIENT_REQUIRED', 403);
    if (!this.available) return { client, available: false, source: 'codex-app-server', threads: [], workspaces: [], hasMore: false, issues: [{ reason: 'transport_unavailable' }] };
    try {
      const page = await this.#request('thread/list', { limit: CODEX_HISTORY_LIMITS.pageSize, sortKey: 'updated_at', archived: false });
      if (!Array.isArray(page?.data)) throw new Error('Invalid thread list');
      const threads = page.data.map(thread => this.#metadata(thread)).filter(thread => thread && !thread.excluded).map(({ excluded: _excluded, ...thread }) => thread);
      return { client, available: true, source: 'codex-app-server', threads, workspaces: [...new Set(threads.map(thread => thread.workspace).filter(Boolean))], hasMore: Boolean(page.nextCursor), issues: [] };
    } catch { return { client, available: false, source: 'codex-app-server', threads: [], workspaces: [], hasMore: false, issues: [{ reason: 'thread_metadata_unavailable' }] }; }
  }
  async #turns(threadId, methods, report, readCache) {
    if (!methods.has('thread/turns/list')) {
      const response = readCache.get(threadId) ?? await this.#request('thread/read', { threadId, includeTurns: true });
      if (!response?.thread || !Array.isArray(response.thread.turns)) throw new Error('Invalid thread read');
      readCache.set(threadId, response);
      return { thread: response.thread, turns: response.thread.turns.slice(-CODEX_HISTORY_LIMITS.maxTurnsPerThread), leftoverTurns: Math.max(0, response.thread.turns.length - CODEX_HISTORY_LIMITS.maxTurnsPerThread) };
    }
    try {
      const turns = []; let cursor;
      for (let page = 0; page < CODEX_HISTORY_LIMITS.maxItemPages; page++) {
        const response = await this.#request('thread/turns/list', { threadId, ...(cursor ? { cursor } : {}), limit: Math.min(50, CODEX_HISTORY_LIMITS.maxTurnsPerThread - turns.length) });
        if (!Array.isArray(response?.data)) throw new Error('Invalid turn list');
        const remaining = CODEX_HISTORY_LIMITS.maxTurnsPerThread - turns.length;
        turns.push(...response.data.slice(0, remaining)); cursor = response.nextCursor;
        if (response.data.length > remaining) report.issues.push({ threadId, reason: 'turn_response_limit', omittedTurns: response.data.length - remaining });
        if (!cursor || turns.length >= CODEX_HISTORY_LIMITS.maxTurnsPerThread) break;
      }
      if (cursor) report.issues.push({ threadId, reason: 'turn_page_limit', leftoverCountUnknown: true });
      return { turns, leftoverTurns: cursor ? 1 : 0 };
    } catch (error) {
      if (!methodUnavailable(error)) throw error;
      methods.delete('thread/turns/list');
      report.issues.push({ reason: 'turn_pagination_unsupported_using_thread_read' });
      return this.#turns(threadId, methods, report, readCache);
    }
  }
  async #items(threadId, turn, methods, report, readCache) {
    if (Array.isArray(turn.items) && turn.itemsView !== 'summary') return turn.items;
    const cached = readCache.get(threadId)?.thread.turns.find(candidate => candidate.id === turn.id);
    if (Array.isArray(cached?.items) && cached.itemsView !== 'summary') return cached.items;
    if (!methods.has('thread/items/list')) {
      report.issues.push({ threadId, turnId: turn.id, reason: Array.isArray(turn.items) ? 'items_summary_only' : 'items_not_available' });
      return turn.items ?? cached?.items ?? [];
    }
    let cursor; const items = [];
    for (let page = 0; page < CODEX_HISTORY_LIMITS.maxItemPages; page++) {
      let response;
      try { response = await this.#request('thread/items/list', { threadId, turnId: turn.id, ...(cursor ? { cursor } : {}), limit: 100 }); }
      catch (error) {
        if (!methodUnavailable(error)) throw error;
        methods.delete('thread/items/list'); methods.delete('thread/turns/list');
        report.issues.push({ reason: 'item_pagination_unsupported_using_thread_read' });
        const legacy = await this.#turns(threadId, methods, report, readCache);
        return legacy.turns.find(candidate => candidate.id === turn.id)?.items ?? [];
      }
      if (!Array.isArray(response?.data)) throw new Error('Invalid item page');
      items.push(...response.data); cursor = response.nextCursor;
      if (!cursor) return items;
    }
    report.issues.push({ threadId, turnId: turn.id, reason: 'item_page_limit', leftoverCountUnknown: true });
    return items;
  }
  async freeze(input) {
    validate(input);
    const mode = input.mode ?? 'history', days = input.days ?? 90, workspace = input.workspace ?? 'all';
    const cutoff = this.#clock() - days * 86400000;
    const report = { discoveredThreads: 0, attemptedThreads: 0, readThreads: 0, sourceCount: 0, sourceChars: 0, skippedThreads: 0, skippedItems: 0, truncatedItems: 0, leftoverThreads: 0, leftoverTurns: 0, issues: [] };
    if (mode === 'current' && !input.currentThreadId) return { sources: [], report: { ...report, issues: [{ reason: 'needs_host_context' }] } };
    const methods = await this.#methods(), candidates = [];
    if (mode === 'current') candidates.push({ id: input.currentThreadId });
    else {
      let cursor;
      const seenThreads = new Set();
      for (let pageNumber = 0; pageNumber < CODEX_HISTORY_LIMITS.maxThreadPages; pageNumber++) {
        const response = await this.#request('thread/list', { limit: CODEX_HISTORY_LIMITS.pageSize, sortKey: 'updated_at', archived: false,
          ...(workspace !== 'all' ? { cwd: workspace } : {}), ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(response?.data)) fail('Codex 返回的历史列表格式不可用。', 'CODEX_HISTORY_INVALID_RESPONSE', 503);
        for (const thread of response.data) {
          const meta = this.#metadata(thread);
          if (!meta || seenThreads.has(meta.id)) continue;
          seenThreads.add(meta.id); report.discoveredThreads++;
          if (meta.excluded || (workspace !== 'all' && !sameWorkspace(meta.workspace, workspace)) || !meta.updatedAt || Date.parse(meta.updatedAt) < cutoff) { report.skippedThreads++; continue; }
          candidates.push(thread);
        }
        cursor = response.nextCursor;
        if (!cursor) break;
        if (pageNumber === CODEX_HISTORY_LIMITS.maxThreadPages - 1) report.issues.push({ reason: 'thread_page_limit', leftoverCountUnknown: true });
      }
    }
    const sources = [], seenItems = new Set(), readCache = new Map();
    for (let index = 0; index < candidates.length; index++) {
      if (report.attemptedThreads >= CODEX_HISTORY_LIMITS.maxReadThreads || sources.length >= CODEX_HISTORY_LIMITS.maxSources || report.sourceChars >= CODEX_HISTORY_LIMITS.maxSourceChars) { report.leftoverThreads += candidates.length - index; break; }
      const candidate = candidates[index];
      report.attemptedThreads++;
      try {
        const result = await this.#turns(candidate.id, methods, report, readCache);
        const thread = { ...candidate, ...(result.thread ?? {}) };
        if (excluded(thread) || (workspace !== 'all' && !sameWorkspace(thread.cwd, workspace))) { report.skippedThreads++; continue; }
        report.readThreads++; report.leftoverTurns += result.leftoverTurns;
        for (const [turnIndex, turn] of result.turns.entries()) {
          if (sources.length >= CODEX_HISTORY_LIMITS.maxSources || report.sourceChars >= CODEX_HISTORY_LIMITS.maxSourceChars) { report.leftoverTurns += result.turns.length - turnIndex; break; }
          if (!identifier(turn.id) || excluded(turn)) continue;
          const items = await this.#items(candidate.id, turn, methods, report, readCache);
          for (const value of items) {
            const wrapper = value?.item && typeof value.item === 'object' ? value : null;
            const item = wrapper?.item ?? value;
            if (item?.type !== 'userMessage' || (item.role !== undefined && item.role !== 'user') || excluded(item) || excluded(wrapper)
              || !identifier(item.id) || wrapper?.turnId !== undefined && wrapper.turnId !== turn.id) { report.skippedItems++; continue; }
            const identity = `${candidate.id}\u0000${turn.id}\u0000${item.id}`;
            if (seenItems.has(identity)) continue;
            seenItems.add(identity);
            const authored = milliseconds(item.startedAtMs ?? wrapper?.startedAtMs ?? item.completedAtMs ?? wrapper?.completedAtMs)
              ?? time(item.createdAt ?? item.timestamp ?? turn.startedAt ?? turn.createdAt);
            const threadCreated = time(thread.createdAt);
            if (mode !== 'current' && ((authored !== null && authored < cutoff) || (authored === null && (threadCreated === null || threadCreated < cutoff)))) { report.skippedItems++; report.issues.push({ threadId: candidate.id, turnId: turn.id, itemId: item.id, reason: authored === null ? 'message_date_unknown' : 'message_before_range' }); continue; }
            const authoredText = Array.isArray(item.content) ? item.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
            const text = visibleCodexUserText(authoredText);
            if (!text.trim()) { report.skippedItems++; continue; }
            const remaining = CODEX_HISTORY_LIMITS.maxSourceChars - report.sourceChars;
            if (sources.length >= CODEX_HISTORY_LIMITS.maxSources || remaining <= 0) { report.skippedItems++; report.issues.push({ threadId: candidate.id, reason: 'source_snapshot_limit', leftoverCountUnknown: true }); continue; }
            let content = text.slice(0, Math.min(CODEX_HISTORY_LIMITS.maxMessageChars, remaining));
            if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1);
            const truncated = content.length < text.length;
            if (truncated) report.truncatedItems++;
            const occurredAt = authored !== null ? new Date(authored).toISOString() : null;
            sources.push({ sourceId: `history-${digest(identity).slice(0, 32)}`, kind: mode === 'current' ? 'current_conversation' : 'codex_history', content, sha256: digest(content),
              threadId: candidate.id, turnId: turn.id, itemId: item.id, occurredAt, timestampBasis: authored === null ? 'thread_created_within_range' : 'message_or_turn', truncated,
              provenance: `Codex 对话 ${candidate.id.slice(0, 80)} / ${turn.id.slice(0, 60)} / ${item.id.slice(0, 60)}${occurredAt ? ` · ${occurredAt}` : ''}` });
            report.sourceChars += content.length;
          }
        }
      } catch { report.skippedThreads++; report.issues.push({ threadId: candidate.id, reason: 'thread_read_unavailable' }); }
    }
    report.sourceCount = sources.length;
    return { sources, report };
  }
}
