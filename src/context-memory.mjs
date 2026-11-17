import { createHash, randomUUID } from 'node:crypto';
import { createAtomicFileStorage } from './atomic-file-storage.mjs';
import { getDataDirectory } from './server-storage.mjs';
import { recallTerms } from './task-recall.mjs';

const CLIENTS = ['chatgpt', 'workbuddy', 'codex', 'claude-code'];
const KINDS = ['goal', 'decision', 'constraint', 'progress', 'next_action'];
const SUMMARY_LISTS = ['decisions', 'constraints', 'openQuestions', 'nextActions'];
const SUMMARY_KEYS = ['overview', ...SUMMARY_LISTS, 'sourceMessageIds'];
const CONVERSATION_KEYS = ['client', 'conversationId', 'projectId', 'revision', 'createdAt', 'updatedAt', 'messages', 'summary'];
const PROJECT_KEYS = ['id', 'client', 'projectId', 'kind', 'content', 'source', 'revision', 'createdAt', 'updatedAt', 'referenceOnly'];
const emptyState = () => ({ version: 1, conversations: [], projectMemories: [] });
const clone = value => JSON.parse(JSON.stringify(value));

export class ContextMemoryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ContextMemoryError';
    this.code = code;
    this.status = status;
  }
}

const fail = (message, code = 'CONTEXT_VALIDATION_ERROR', status = 400) => {
  throw new ContextMemoryError(code, message, status);
};

function object(value, allowed, required = allowed) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) fail('上下文记忆包含未知字段或缺少必要字段。');
}

function text(value, label, maximum = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail(`${label}必须为 1–${maximum} 个字符的文本。`);
  return value;
}

function list(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1
    || Array.from({ length: value.length }, (_, index) => index).some(index => !Object.hasOwn(value, index))) fail(`${label}必须是连续列表，最多 ${maximum} 项。`);
  return value;
}

function ids(value, maximum, label) {
  list(value, maximum, label).forEach(item => text(item, label));
  if (new Set(value).size !== value.length) fail(`${label}包含重复编号。`);
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label}必须是 ${minimum}–${maximum} 的整数。`);
  return value;
}

function client(value) {
  if (!CLIENTS.includes(value)) fail('上下文记忆客户端无效。');
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) fail('消息时间必须是有效的 ISO 日期时间。');
}

function validateMessage(message) {
  object(message, ['id', 'role', 'content', 'at'], ['id', 'role', 'content']);
  text(message.id, '消息编号');
  if (!['user', 'assistant'].includes(message.role)) fail('消息角色只支持 user 和 assistant。');
  text(message.content, '消息内容', 16000);
  if (message.at !== undefined) timestamp(message.at);
}

function validateMessages(messages, maximum) {
  list(messages, maximum, '消息列表').forEach(validateMessage);
  if (new Set(messages.map(message => message.id)).size !== messages.length) fail('同一批对话中消息编号重复。');
}

function validateSummary(summary, messages) {
  object(summary, SUMMARY_KEYS);
  text(summary.overview, '对话摘要', 4000);
  for (const key of SUMMARY_LISTS) list(summary[key], 30, key).forEach(item => text(item, key, 1000));
  const sourceIds = ids(summary.sourceMessageIds, 2000, '摘要来源消息');
  if (!sourceIds.length || sourceIds.some(id => !messages.some(message => message.id === id))) fail('摘要需要引用实际已保存的消息。');
  if (JSON.stringify(summary).length > 12000) fail('结构化摘要最多 12000 个字符。');
}

function validateSource(source, conversation) {
  object(source, ['conversationId', 'messageIds']);
  text(source.conversationId, '来源对话编号');
  const sourceIds = ids(source.messageIds, 100, '项目来源消息');
  if (!sourceIds.length || sourceIds.some(id => !conversation.messages.some(message => message.id === id))) fail('项目记忆需要引用实际已保存的来源消息。');
}

function validateState(state) {
  object(state, ['version', 'conversations', 'projectMemories']);
  if (state.version !== 1) fail('上下文记忆文件版本不受支持。');
  const conversationKeys = new Set();
  for (const conversation of list(state.conversations, 200, '已保存对话')) {
    object(conversation, CONVERSATION_KEYS);
    client(conversation.client);
    text(conversation.conversationId, '对话编号');
    if (conversation.projectId !== null) text(conversation.projectId, '项目编号');
    integer(conversation.revision, 1, Number.MAX_SAFE_INTEGER, '对话版本');
    timestamp(conversation.createdAt);
    timestamp(conversation.updatedAt);
    validateMessages(conversation.messages, 2000);
    if (!conversation.messages.length || JSON.stringify(conversation.messages).length > 4 * 1024 * 1024) fail('已保存对话大小无效。');
    if (conversation.summary !== null) validateSummary(conversation.summary, conversation.messages);
    const key = JSON.stringify([conversation.client, conversation.conversationId]);
    if (conversationKeys.has(key)) fail('已保存对话编号重复。');
    conversationKeys.add(key);
  }
  const memoryIds = new Set();
  for (const memory of list(state.projectMemories, 5000, '项目记忆')) {
    object(memory, PROJECT_KEYS);
    text(memory.id, '项目记忆编号');
    client(memory.client);
    text(memory.projectId, '项目编号');
    if (!KINDS.includes(memory.kind) || memory.referenceOnly !== true) fail('项目记忆类型或参考标记无效。');
    text(memory.content, '项目记忆内容', 4000);
    integer(memory.revision, 1, Number.MAX_SAFE_INTEGER, '项目记忆版本');
    timestamp(memory.createdAt);
    timestamp(memory.updatedAt);
    const conversation = state.conversations.find(item => item.client === memory.client
      && item.conversationId === memory.source?.conversationId && item.projectId === memory.projectId);
    if (!conversation) fail('项目记忆来源不属于同一客户端和项目。');
    validateSource(memory.source, conversation);
    if (memoryIds.has(memory.id)) fail('项目记忆编号重复。');
    memoryIds.add(memory.id);
  }
  return state;
}

export function createContextMemoryStorage({ root, env = process.env, directory = getDataDirectory(root, env), fileSystem }) {
  return createAtomicFileStorage({ directory, basename: 'context-memory.json', createDirectory: true, fileSystem,
    messages: { unreadable: 'Invalid context memory file', tooLarge: 'Context memory exceeds storage limit', changed: 'Context memory changed outside this service' } });
}

function extractiveSummary(messages, query) {
  const seen = new Set();
  const selected = [];
  let characters = 0;
  const candidates = messages.map((message, index) => ({ message, index,
    score: query ? rankContent(message.content, query, recallTerms(query)) : 0 }));
  // Prefer relevant turns, then recent turns. Keep complete messages and roles.
  candidates.sort((a, b) => b.score - a.score || b.index - a.index);
  for (const { message, index } of candidates) {
    const key = JSON.stringify([message.role, message.content]);
    const excerpt = `${message.role === 'user' ? '用户' : '助手'} [${message.id}] ${message.content}`;
    if (seen.has(key) || characters + excerpt.length + (selected.length ? 2 : 0) > 4000) continue;
    seen.add(key);
    characters += excerpt.length + (selected.length ? 2 : 0);
    selected.push({ id: message.id, excerpt, index });
  }
  selected.sort((a, b) => a.index - b.index);
  return { overview: selected.map(message => message.excerpt).join('\n\n'), decisions: [], constraints: [], openQuestions: [], nextActions: [],
    sourceMessageIds: selected.map(message => message.id) };
}

function conversationView(conversation, query) {
  const useHostSummary = conversation.summary !== null
    && (!query || rankContent(JSON.stringify(conversation.summary), query, recallTerms(query)) > 0);
  const summary = useHostSummary ? conversation.summary : extractiveSummary(conversation.messages, query);
  const sourceIds = new Set(summary.sourceMessageIds);
  const compression = {
    method: useHostSummary ? 'host_summary' : 'extractive-v1',
    originalChars: conversation.messages.reduce((sum, message) => sum + message.content.length, 0),
    summaryChars: JSON.stringify(summary).length,
    totalMessages: conversation.messages.length,
    coveredMessages: sourceIds.size,
    omittedMessages: conversation.messages.length - sourceIds.size,
    rawPreserved: true,
    complete: sourceIds.size === conversation.messages.length,
    ...(sourceIds.size ? {} : { notice: '消息超过完整摘录长度限制，摘要没有可返回的完整消息；原文已保存。' }),
  };
  return {
    conversationId: conversation.conversationId, client: conversation.client, projectId: conversation.projectId,
    revision: conversation.revision, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length, summary: { ...clone(summary), referenceOnly: true }, compression,
    evidence: conversation.messages.filter(message => sourceIds.has(message.id)).map(message => ({ messageId: message.id, role: message.role })),
    referenceOnly: true,
  };
}

function rankContent(content, query, terms) {
  const normalized = content.normalize('NFKC').toLocaleLowerCase();
  const words = new Set(recallTerms(content));
  return terms.filter(term => words.has(term)).length + (normalized.includes(query.normalize('NFKC').toLocaleLowerCase()) ? 2 : 0);
}

function projectMemoryView(memory, conversation) {
  const sourceIds = new Set(memory.source.messageIds);
  return { ...clone(memory), evidence: conversation.messages.filter(message => sourceIds.has(message.id))
    .map(message => ({ messageId: message.id, role: message.role })) };
}

export class ContextMemory {
  #storage;
  #clock;
  #state = emptyState();

  constructor({ storage = null, clock = () => Date.now() } = {}) {
    this.#storage = storage;
    this.#clock = clock;
  }

  #load() {
    if (!this.#storage) return;
    try {
      const serialized = this.#storage.getItem('context-memory');
      this.#state = serialized == null ? emptyState() : validateState(JSON.parse(serialized));
    } catch {
      fail('无法读取上下文记忆文件，请检查存储状态。', 'CONTEXT_STORAGE_INVALID', 503);
    }
  }

  #save(next) {
    validateState(next);
    try { this.#storage?.setItem('context-memory', JSON.stringify(next)); }
    catch { fail('上下文记忆保存失败，请重试。', 'CONTEXT_STORAGE_UNAVAILABLE', 503); }
    this.#state = next;
  }

  getSnapshot({ withCompression = false } = {}) {
    this.#load();
    const snapshot = clone(this.#state);
    if (withCompression) snapshot.conversations = snapshot.conversations.map(conversation => ({ ...conversation, ...conversationView(conversation) }));
    return snapshot;
  }

  saveConversation(requestedClient, input) {
    client(requestedClient);
    object(input, ['conversationId', 'projectId', 'expectedRevision', 'messages', 'summary'], ['conversationId', 'messages']);
    text(input.conversationId, '对话编号');
    if (input.projectId !== undefined) text(input.projectId, '项目编号');
    if (input.expectedRevision !== undefined) integer(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER, '对话版本');
    validateMessages(input.messages, 200);
    this.#load();
    const existing = this.#state.conversations.find(item => item.client === requestedClient && item.conversationId === input.conversationId);
    if (existing && existing.projectId !== (input.projectId ?? null)) fail('此对话已经绑定到其他项目范围。', 'CONTEXT_SCOPE_MISMATCH', 409);
    const timestamp = new Date(this.#clock()).toISOString();
    const conversation = existing ? clone(existing) : {
      conversationId: input.conversationId, client: requestedClient, projectId: input.projectId ?? null,
      revision: 1, createdAt: timestamp, updatedAt: timestamp, messages: [], summary: null,
    };
    for (const message of input.messages) {
      const previous = conversation.messages.find(item => item.id === message.id);
      if (previous && (previous.role !== message.role || previous.content !== message.content || previous.at !== message.at)) fail('已保存消息的编号对应不同内容，请使用新的消息编号。', 'CONTEXT_MESSAGE_CONFLICT', 409);
      if (!previous) conversation.messages.push(clone(message));
    }
    if (!conversation.messages.length) fail('对话至少需要一条消息。');
    if (existing && conversation.messages.length > existing.messages.length && input.summary === undefined) conversation.summary = null;
    if (input.summary !== undefined) {
      validateSummary(input.summary, conversation.messages);
      conversation.summary = clone(input.summary);
    }
    const unchanged = existing && JSON.stringify(existing.messages) === JSON.stringify(conversation.messages)
      && JSON.stringify(existing.summary) === JSON.stringify(conversation.summary);
    if (unchanged) return { conversation: conversationView(existing), unchanged: true };
    if (existing && input.summary !== undefined && input.expectedRevision === undefined) fail('更新摘要需要读取当前对话版本并提供 expectedRevision。', 'CONTEXT_REVISION_REQUIRED', 409);
    if (input.expectedRevision !== undefined && input.expectedRevision !== existing?.revision) fail('对话资料已经变化，请读取最新版本后重试。', 'CONTEXT_REVISION_CONFLICT', 409);
    if (existing) {
      conversation.revision++;
      conversation.updatedAt = timestamp;
    }
    const next = clone(this.#state);
    if (existing) next.conversations[next.conversations.findIndex(item => item.client === requestedClient && item.conversationId === input.conversationId)] = conversation;
    else next.conversations.push(conversation);
    this.#save(next);
    return { conversation: conversationView(conversation), unchanged: false };
  }

  saveProjectMemory(requestedClient, input) {
    return this.#saveProjectMemory(requestedClient, input);
  }

  // Reserved IDs keep derived recorder progress separate from manually written
  // project notes. Rebuilding the same view is safe after a metadata-write retry.
  saveAutomaticProjectProgress(requestedClient, input) {
    client(requestedClient);
    object(input, ['projectId', 'conversationId', 'content', 'messageIds']);
    text(input.projectId, '项目编号');
    text(input.conversationId, '来源对话编号');
    const automaticId = `auto-progress-${createHash('sha256').update(JSON.stringify([requestedClient, input.projectId, input.conversationId])).digest('hex')}`;
    this.#load();
    const existing = this.#state.projectMemories.find(memory => memory.id === automaticId);
    return this.#saveProjectMemory(requestedClient, { projectId: input.projectId, id: automaticId,
      expectedRevision: existing?.revision ?? 1, kind: 'progress', content: input.content,
      source: { conversationId: input.conversationId, messageIds: input.messageIds } }, { automaticId });
  }

  #saveProjectMemory(requestedClient, input, { automaticId } = {}) {
    client(requestedClient);
    object(input, ['projectId', 'id', 'expectedRevision', 'kind', 'content', 'source'], ['projectId', 'kind', 'content', 'source']);
    text(input.projectId, '项目编号');
    text(input.content, '项目记忆内容', 4000);
    if (!KINDS.includes(input.kind)) fail('项目记忆类型无效。');
    if (input.id !== undefined) text(input.id, '项目记忆编号');
    if ((input.id === undefined) !== (input.expectedRevision === undefined)) fail('修改项目记忆需要同时提供 id 和 expectedRevision。');
    if (input.expectedRevision !== undefined) integer(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER, '项目记忆版本');
    object(input.source, ['conversationId', 'messageIds']);
    this.#load();
    const conversation = this.#state.conversations.find(item => item.client === requestedClient && item.projectId === input.projectId && item.conversationId === input.source.conversationId);
    if (!conversation) fail('找不到当前客户端和项目中的来源对话。', 'CONTEXT_SOURCE_NOT_FOUND', 404);
    validateSource(input.source, conversation);
    const existing = input.id === undefined ? this.#state.projectMemories.find(item => item.client === requestedClient
      && item.projectId === input.projectId && item.kind === input.kind && item.content === input.content
      && JSON.stringify(item.source) === JSON.stringify(input.source))
      : this.#state.projectMemories.find(item => item.id === input.id && item.client === requestedClient && item.projectId === input.projectId);
    if (input.id !== undefined && !existing && input.id !== automaticId) fail('找不到当前范围内的项目记忆。', 'CONTEXT_MEMORY_NOT_FOUND', 404);
    if (existing && existing.kind === input.kind && existing.content === input.content && JSON.stringify(existing.source) === JSON.stringify(input.source)) return { memory: projectMemoryView(existing, conversation), unchanged: true };
    if (existing && input.expectedRevision !== existing.revision) fail('项目记忆已经变化，请读取最新版本后重试。', 'CONTEXT_REVISION_CONFLICT', 409);
    const timestamp = new Date(this.#clock()).toISOString();
    const memory = { id: existing?.id ?? automaticId ?? randomUUID(), client: requestedClient, projectId: input.projectId,
      kind: input.kind, content: input.content, source: clone(input.source), revision: existing ? existing.revision + 1 : 1,
      createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp, referenceOnly: true };
    const next = clone(this.#state);
    if (existing) next.projectMemories[next.projectMemories.findIndex(item => item.id === existing.id)] = memory;
    else next.projectMemories.push(memory);
    this.#save(next);
    return { memory: projectMemoryView(memory, conversation), unchanged: false };
  }

  recall(requestedClient, input, { rankedOnly = false } = {}) {
    client(requestedClient);
    object(input, ['query', 'projectId', 'conversationId', 'include', 'budget', 'limit'], ['query', 'include']);
    text(input.query, '任务查询', 2000);
    if (input.projectId !== undefined) text(input.projectId, '项目编号');
    if (input.conversationId !== undefined) text(input.conversationId, '对话编号');
    ids(input.include, 2, '请求记忆类型');
    if (input.include.some(kind => !['conversations', 'project'].includes(kind))) fail('请求记忆类型无效。');
    if (input.include.includes('project') && input.projectId === undefined) fail('请求项目记忆需要明确 projectId。');
    if (input.include.includes('conversations') && input.projectId === undefined && input.conversationId === undefined) fail('请求对话需要明确 conversationId 或 projectId。');
    const budget = integer(input.budget ?? 6000, 256, 16000, '上下文字符预算');
    const limit = integer(input.limit ?? 8, 1, 20, '上下文条数');
    this.#load();
    const terms = recallTerms(input.query);
    const candidates = [];
    if (input.include.includes('conversations')) {
      for (const conversation of this.#state.conversations) {
        if (conversation.client !== requestedClient || conversation.projectId !== (input.projectId ?? null)
          || input.conversationId !== undefined && conversation.conversationId !== input.conversationId) continue;
        const view = conversationView(conversation, input.query);
        const searchable = [JSON.stringify(conversation.summary), ...conversation.messages.map(message => message.content)].join('\n');
        const score = rankContent(searchable, input.query, terms);
        // A caller requesting one known conversation may resume it with a new query.
        if (score || input.conversationId === conversation.conversationId) candidates.push({ type: 'conversations', value: view, score });
      }
    }
    if (input.include.includes('project')) {
      for (const memory of this.#state.projectMemories) {
        if (memory.client !== requestedClient || memory.projectId !== input.projectId) continue;
        const score = rankContent(memory.content, input.query, terms);
        if (score) {
          const conversation = this.#state.conversations.find(item => item.client === memory.client
            && item.projectId === memory.projectId && item.conversationId === memory.source.conversationId);
          candidates.push({ type: 'projectMemories', value: projectMemoryView(memory, conversation), score });
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score || b.value.updatedAt.localeCompare(a.value.updatedAt));
    const result = { conversations: [], projectMemories: [] };
    // Internal composition keeps candidates until the combined budget is known.
    if (rankedOnly) {
      for (const candidate of candidates) result[candidate.type].push(candidate.value);
      return { ...result, retrieval: { matchedCount: candidates.length } };
    }
    let returned = 0;
    for (const candidate of candidates) {
      if (returned >= limit) break;
      result[candidate.type].push(candidate.value);
      if (JSON.stringify(result).length > budget) result[candidate.type].pop();
      else returned++;
    }
    return { ...result, retrieval: { method: 'scoped-lexical-v1', budgetChars: budget,
      returnedChars: JSON.stringify(result).length, matchedCount: candidates.length, omittedCount: candidates.length - returned } };
  }
}
