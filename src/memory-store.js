import { PROFILE_FIELDS, parseProfileContent, profileSectionEntries } from './profile-model.js';
import { profileItemCollision, profileItemForWrite } from './profile-item-identity.mjs';
import { MEMORY_TYPES } from './memory-types.js';
import { REVIEW_REASONS, isUsableMemory } from './memory-policy.js';
import { CATEGORIES, WORKSPACES } from './memory-taxonomy.mjs';
import { ReadAuditError, buildReadDetails, validateReadDetails } from './memory-read-audit.mjs';
import { readStorageStatus } from './storage-status.mjs';
import { CaptureAuditError, buildCaptureAudit, validateCaptureDetails } from './memory-capture-audit.mjs';
import { validateProfileAgeReadView } from './profile-age.js';

export const STORAGE_KEY = 'memory-ui-demo:v1';
export { CATEGORIES, WORKSPACES } from './memory-taxonomy.mjs';

const STATUSES = ['active', 'pending', 'paused', 'expired', 'rejected'];
const ORIGINS = ['manual', 'inferred', 'imported'];
const MUTABLE_FIELDS = ['content', 'category', 'workspace', 'audience', 'validUntil', 'memoryType', 'reviewReasons'];
const OPTIONAL_MEMORY_FIELDS = ['memoryType', 'reviewReasons'];
const HISTORY_FIELDS = [...MUTABLE_FIELDS, 'status', 'confirmed'];
const HISTORY_ACTIONS = ['created', 'updated', 'stated', 'proposed', 'confirmed', 'rejected', 'paused', 'activated', 'expired', 'superseded', 'imported'];
const EVENT_TYPES = [...HISTORY_ACTIONS.map((action) => `memory.${action}`), 'memory.deleted', 'memory.captured', 'connection.updated', 'demo.read', 'local.read', 'data.imported', 'mem0.imported', 'demo.reset'];
const AGENT_PLATFORMS = new Set(['Codex', 'Claude Code', 'WorkBuddy', 'ChatGPT']);
const SETUP_PLATFORMS = Object.freeze({ codex: 'Codex', 'claude-code': 'Claude Code', workbuddy: 'WorkBuddy', chatgpt: 'ChatGPT' });
const OPTIONAL_LOCAL_CLIENTS = [
  { id: 'claude-code', name: 'Claude Code', mode: 'local-agent', enabled: false, workspaces: [], lastReadAt: null },
  { id: 'workbuddy', name: 'WorkBuddy', mode: 'local-agent', enabled: false, workspaces: [], lastReadAt: null },
  { id: 'chatgpt', name: 'ChatGPT', mode: 'local-agent', enabled: false, workspaces: [], lastReadAt: null },
];

function addMissingLocalClients(snapshot) {
  const missing = OPTIONAL_LOCAL_CLIENTS.filter(client => !snapshot.connections.some(c => c.id === client.id));
  if (missing.length) snapshot.connections.push(...clone(missing));
  const chatgpt = snapshot.connections.find(client => client.id === 'chatgpt');
  const legacyExport = chatgpt?.mode === 'export';
  if (legacyExport) {
    // Export previews were never permission for a live client to read. Keep
    // their selected workspaces visible, with every old grant paused.
    chatgpt.mode = 'local-agent';
    chatgpt.enabled = false;
    chatgpt.pausedLegacyGrants = { workspaces: true, newMemories: true };
  }
  return missing.length + Number(legacyExport);
}

export class MemoryStoreError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MemoryStoreError';
    this.code = code;
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const id = () => globalThis.crypto?.randomUUID?.() ?? `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const fail = (message) => { throw new MemoryStoreError('VALIDATION_ERROR', message); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function object(value, fields, required = fields, label = '数据') {
  if (!isObject(value)) fail(`${label}必须是普通对象。`);
  if (Object.keys(value).some((key) => !fields.includes(key))) fail(`${label}包含不支持的字段。`);
  if (required.some((key) => !Object.hasOwn(value, key))) fail(`${label}缺少必要字段。`);
}

function string(value, label, maximum = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail(`${label}必须是 1–${maximum} 个字符的非空文本。`);
  return value;
}

function enumeration(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label}无效。`);
  return value;
}

function timestamp(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${label}必须是有效的 ISO 日期时间。`);
  const datePart = value.slice(0, 10);
  if (new Date(`${datePart}T00:00:00.000Z`).toISOString().slice(0, 10) !== datePart) fail(`${label}日期不存在。`);
  return value;
}

function expiry(value) {
  if (value === null) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T23:59:59.999`);
    if (!Number.isFinite(date.getTime()) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) fail('到期日期不存在。');
    return date.toISOString();
  }
  return timestamp(value, '到期时间', true);
}

function strings(value, label, allowed, maximum = 100) {
  if (!Array.isArray(value) || value.length > maximum || value.some((entry) => typeof entry !== 'string' || !entry || entry.length > 100)) fail(`${label}必须是文本列表。`);
  if (new Set(value).size !== value.length || (allowed && value.some((entry) => !allowed.includes(entry)))) fail(`${label}包含重复或未知值。`);
  return [...value];
}

function profileSharingPolicy(value) {
  object(value, ['enabled', 'categories'], undefined, '主题共享');
  if (Reflect.ownKeys(value).some(key => !['enabled', 'categories'].includes(key))) fail('主题共享包含不支持的字段。');
  if (typeof value.enabled !== 'boolean') fail('主题共享开关必须是布尔值。');
  const categories = strings(value.categories, '共享主题', CATEGORIES, CATEGORIES.length);
  if (Reflect.ownKeys(value.categories).length !== value.categories.length + 1
      || Array.from({ length: value.categories.length }, (_, index) => index).some(index => !Object.hasOwn(value.categories, index))) fail('共享主题必须是连续的文本列表。');
  if (value.enabled && !categories.length) fail('请选择至少一个共享主题。');
  return { enabled: value.enabled, categories: CATEGORIES.filter(category => categories.includes(category)) };
}

function pausedLegacyGrantPolicy(value) {
  object(value, ['workspaces', 'newMemories'], undefined, '原授权暂停状态');
  if (Reflect.ownKeys(value).some(key => !['workspaces', 'newMemories'].includes(key))
      || typeof value.workspaces !== 'boolean' || typeof value.newMemories !== 'boolean') fail('原授权暂停状态必须包含两个布尔值。');
  return { workspaces: value.workspaces, newMemories: value.newMemories };
}

const realMemory = memory => !memory.id.startsWith('demo-') && memory.source.platform.trim() !== '演示对话';
const includedInProfileSharing = (memory, policy, client) => policy?.enabled === true
  && policy.categories.includes(memory.category) && realMemory(memory) && isUsableMemory(memory)
  && (!memory.audience.length || memory.audience.includes(client));

function field(name, value, { initial = false } = {}) {
  if (initial && value === null) return null;
  switch (name) {
    case 'content': return string(value, '记忆内容');
    case 'category': return enumeration(value, CATEGORIES, '记忆类别');
    case 'workspace': return enumeration(value, WORKSPACES, '空间');
    case 'audience': return strings(value, '可读取平台');
    case 'validUntil': return expiry(value);
    case 'memoryType': return enumeration(value, Object.keys(MEMORY_TYPES), '记忆类型');
    case 'reviewReasons': return strings(value, '核对原因', Object.keys(REVIEW_REASONS), Object.keys(REVIEW_REASONS).length);
    case 'status': return enumeration(value, STATUSES, '记忆状态');
    case 'confirmed': if (typeof value !== 'boolean') fail('确认标记必须是布尔值。'); return value;
    default: fail('不支持的修改字段。');
  }
}

function validateSource(source) {
  object(source, ['label', 'excerpt', 'platform', 'at', 'upstreamId'], ['label', 'excerpt', 'platform', 'at'], '记忆来源');
  string(source.label, '来源标签', 300);
  string(source.excerpt, '来源原文', 16000);
  string(source.platform, '来源平台', 100);
  timestamp(source.at, '来源时间');
  if (source.upstreamId !== undefined) string(source.upstreamId, '上游记忆编号', 300);
}

function validateMemory(memory) {
  const required = ['id', 'content', 'category', 'workspace', 'audience', 'status', 'origin', 'confirmed', 'revision', 'createdAt', 'updatedAt', 'validUntil', 'source', 'history'];
  object(memory, [...required, 'supersedes', ...OPTIONAL_MEMORY_FIELDS], required, '记忆');
  string(memory.id, '记忆编号', 100);
  HISTORY_FIELDS.forEach((key) => { if (!OPTIONAL_MEMORY_FIELDS.includes(key) || Object.hasOwn(memory, key)) field(key, memory[key]); });
  enumeration(memory.origin, ORIGINS, '产生方式');
  if (!Number.isSafeInteger(memory.revision) || memory.revision < 1) fail('版本号必须是正整数。');
  if (['pending', 'rejected'].includes(memory.status) && memory.confirmed) fail('待确认或已拒绝的记忆不能标记为已确认。');
  timestamp(memory.createdAt, '创建时间');
  timestamp(memory.updatedAt, '更新时间');
  validateSource(memory.source);
  if (memory.supersedes !== undefined) string(memory.supersedes, '替代记忆编号', 100);
  if (!Array.isArray(memory.history) || memory.history.length > 10000) fail('修改历史必须是列表。');
  const seen = new Set();
  let previousRevision = 0;
  for (const entry of memory.history) {
    object(entry, ['id', 'at', 'action', 'revision', 'changes', 'source'], ['id', 'at', 'action', 'revision', 'changes'], '修改历史');
    if (entry.source !== undefined) validateSource(entry.source);
    string(entry.id, '历史编号', 100);
    if (seen.has(entry.id)) fail('历史编号重复。');
    seen.add(entry.id);
    timestamp(entry.at, '历史时间');
    enumeration(entry.action, HISTORY_ACTIONS, '历史操作');
    if (!Number.isSafeInteger(entry.revision) || entry.revision <= previousRevision || entry.revision > memory.revision) fail('历史版本必须递增且不超过当前版本。');
    previousRevision = entry.revision;
    object(entry.changes, HISTORY_FIELDS, [], '历史修改');
    for (const [key, change] of Object.entries(entry.changes)) {
      object(change, ['from', 'to'], undefined, '修改值');
      field(key, change.from, { initial: true });
      field(key, change.to);
    }
  }
}

function validateConnection(connection) {
  object(connection, ['id', 'name', 'mode', 'enabled', 'workspaces', 'lastReadAt', 'setup', 'memoryIds', 'profileSharing', 'pausedLegacyGrants'], ['id', 'name', 'mode', 'enabled', 'workspaces'], '平台');
  string(connection.id, '平台编号', 100);
  string(connection.name, '平台名称', 100);
  enumeration(connection.mode, ['local-agent', 'demo', 'export'], '平台模式');
  if (typeof connection.enabled !== 'boolean') fail('平台开关必须是布尔值。');
  strings(connection.workspaces, '平台空间', WORKSPACES);
  if (connection.lastReadAt !== undefined) timestamp(connection.lastReadAt, '最近读取时间', true);
  if (connection.setup !== undefined) {
    if (!Object.hasOwn(SETUP_PLATFORMS, connection.id) || connection.mode !== 'local-agent') fail('首次设置仅支持本地智能体。');
    object(connection.setup, ['categories', 'autoCapture', 'readNew', 'createdAt', 'updatedAt'], undefined, '首次设置');
    strings(connection.setup.categories, '保存主题', CATEGORIES, CATEGORIES.length);
    if (!connection.setup.categories.length) fail('请选择至少一个保存主题。');
    if (typeof connection.setup.autoCapture !== 'boolean' || typeof connection.setup.readNew !== 'boolean') fail('首次设置授权必须是布尔值。');
    timestamp(connection.setup.createdAt, '首次设置时间');
    timestamp(connection.setup.updatedAt, '设置更新时间');
  }
  if (connection.memoryIds !== undefined) {
    if (!connection.setup) fail('新增记忆集合需要首次设置授权。');
    strings(connection.memoryIds, '新增记忆集合', undefined, 5000);
  }
  if (Object.hasOwn(connection, 'profileSharing')) {
    if (!Object.hasOwn(SETUP_PLATFORMS, connection.id) || connection.mode !== 'local-agent') fail('主题共享仅支持本地智能体。');
    profileSharingPolicy(connection.profileSharing);
  }
  if (Object.hasOwn(connection, 'pausedLegacyGrants')) pausedLegacyGrantPolicy(connection.pausedLegacyGrants);
}

function validateEvent(event) {
  object(event, ['id', 'type', 'at', 'connectionId', 'memoryIds', 'revision', 'readDetails', 'captureDetails'], ['id', 'type', 'at'], '活动记录');
  string(event.id, '活动编号', 100);
  enumeration(event.type, EVENT_TYPES, '活动类型');
  timestamp(event.at, '活动时间');
  if (event.connectionId !== undefined) string(event.connectionId, '活动平台编号', 100);
  if (event.memoryIds !== undefined) strings(event.memoryIds, '活动记忆编号', undefined, 5000);
  if (event.revision !== undefined && (!Number.isSafeInteger(event.revision) || event.revision < 1)) fail('活动版本号无效。');
  if (Object.hasOwn(event, 'readDetails')) {
    if (event.type !== 'local.read' || !event.connectionId || !Object.hasOwn(event, 'memoryIds')) fail('读取审计详情仅支持有平台和记忆列表的 local.read。');
    readAudit(() => validateReadDetails(event.readDetails, event.memoryIds));
  }
  if (Object.hasOwn(event, 'captureDetails')) {
    if (event.type !== 'memory.captured' || !event.connectionId || !Object.hasOwn(event, 'memoryIds')) fail('整理审计详情仅支持有绑定平台和记忆列表的 memory.captured。');
    readAudit(() => validateCaptureDetails(event.captureDetails, event.memoryIds, event.connectionId, event.id));
  }
}

function readAudit(operation) {
  try { return operation(); }
  catch (error) {
    if (error instanceof ReadAuditError || error instanceof CaptureAuditError) throw new MemoryStoreError('VALIDATION_ERROR', error.message, error);
    throw error;
  }
}

function validateSnapshot(input) {
  object(input, ['schemaVersion', 'memories', 'connections', 'events'], undefined, '备份');
  if (input.schemaVersion !== 1) fail('暂不支持这个备份版本。');
  for (const [key, validator, maximum] of [['memories', validateMemory, 5000], ['connections', validateConnection, 100], ['events', validateEvent, 20000]]) {
    if (!Array.isArray(input[key]) || input[key].length > maximum) fail(`${key}数量无效或超过限制。`);
    const ids = new Set();
    for (const value of input[key]) {
      validator(value);
      if (ids.has(value.id)) fail(`${key}包含重复编号。`);
      ids.add(value.id);
    }
  }
  const connections = new Set(input.connections.map((connection) => connection.id));
  const memories = new Set(input.memories.map((memory) => memory.id));
  for (const memory of input.memories) {
    if (memory.audience.some((connection) => !connections.has(connection))) fail('记忆引用了不存在的平台。');
    if (memory.supersedes && (!memories.has(memory.supersedes) || memory.supersedes === memory.id)) fail('替代记忆引用无效。');
  }
  for (const connection of input.connections) {
    if (connection.memoryIds?.some(memoryId => !memories.has(memoryId))) fail('新增记忆集合引用了不存在的记忆。');
  }
  return clone(input);
}

function event(type, details = {}) {
  return { id: id(), type, at: now(), ...details };
}

function changeMemory(memory, patch, action, at = now()) {
  const changes = {};
  for (const [key, value] of Object.entries(patch)) {
    if (JSON.stringify(memory[key]) !== JSON.stringify(value)) changes[key] = { from: Object.hasOwn(memory, key) ? clone(memory[key]) : null, to: clone(value) };
  }
  memory.revision += 1;
  Object.assign(memory, clone(patch), { updatedAt: at });
  memory.history.push({ id: id(), at, action, revision: memory.revision, changes });
}

function newMemory(input, { status, origin, confirmed, action }) {
  const at = now();
  const content = string(input.content, '记忆内容').trim();
  if (input.source !== undefined) validateSource(input.source);
  const source = input.source === undefined ? { label: '用户手动记录', excerpt: content, platform: 'MemoryUI', at } : clone(input.source);
  const memory = {
    id: id(), content,
    category: input.category ?? CATEGORIES[0], workspace: input.workspace ?? 'general',
    audience: input.audience === undefined ? [] : strings(input.audience, '可读取平台'), status, origin, confirmed, revision: 1,
    createdAt: at, updatedAt: at, validUntil: input.validUntil === undefined ? null : expiry(input.validUntil),
    source,
    history: [{ id: id(), at, action, revision: 1, changes: { content: { from: null, to: content } } }],
  };
  if (Object.hasOwn(input, 'memoryType')) {
    memory.memoryType = field('memoryType', input.memoryType);
    memory.history[0].changes.memoryType = { from: null, to: memory.memoryType };
  }
  if (Object.hasOwn(input, 'reviewReasons')) {
    memory.reviewReasons = field('reviewReasons', input.reviewReasons);
    memory.history[0].changes.reviewReasons = { from: null, to: clone(memory.reviewReasons) };
  }
  if (input.supersedes !== undefined) memory.supersedes = input.supersedes;
  validateMemory(memory);
  return memory;
}

function seed() {
  const at = now();
  const definitions = [
    { id: 'demo-profile', content: '我是一名软件工程师，正在探索自己的 AI 产品想法。', category: '关于我', workspace: 'general' },
    { id: 'demo-language', content: '默认用简体中文与我交流，保留必要的英文产品和技术术语。', category: '沟通偏好', workspace: 'general' },
    { id: 'demo-style', content: '先给出结论，再解释理由；需要我决策时列出少量清晰选项。', category: '沟通偏好', workspace: 'general' },
    { id: 'demo-project', content: '当前项目是跨平台 AI 记忆管理工具，第一版面向普通 AI 用户。', category: '当前项目', workspace: 'work', audience: ['codex', 'claude'] },
    { id: 'demo-personal', content: '旅行时喜欢步行、当地咖啡馆和留出自由探索的时间。', category: '生活偏好', workspace: 'personal' },
    { id: 'demo-private', content: '周日晚上保留一小时整理个人计划；这条只留在私密空间。', category: '生活偏好', workspace: 'private' },
    { id: 'demo-pending', content: '我是一名全职产品设计师。', category: '关于我', workspace: 'general', status: 'pending', supersedes: 'demo-profile', origin: 'inferred' },
    { id: 'demo-expired', content: '本周五之前完成上一个项目的演示材料。', category: '当前项目', workspace: 'work', status: 'expired' },
  ];
  const memories = definitions.map((definition) => {
    const pending = definition.status === 'pending';
    const memory = newMemory({ ...definition, source: {
      label: pending ? 'AI 推测 · 示例数据' : '本人确认 · 示例数据',
      excerpt: pending ? '最近在讨论产品界面。AI 由此推测职业，尚未得到本人确认。' : `示例原文：${definition.content}`,
      platform: '演示对话', at,
    } }, { status: definition.status ?? 'active', origin: definition.origin ?? 'manual', confirmed: !pending, action: pending ? 'proposed' : 'created' });
    memory.id = definition.id;
    return memory;
  });
  return validateSnapshot({ schemaVersion: 1, memories, connections: [
    { id: 'codex', name: 'Codex', mode: 'local-agent', enabled: true, workspaces: ['general', 'work'], lastReadAt: null },
    ...OPTIONAL_LOCAL_CLIENTS,
    { id: 'claude', name: 'Claude', mode: 'demo', enabled: true, workspaces: ['general', 'work'], lastReadAt: null },
    { id: 'gemini', name: 'Gemini', mode: 'demo', enabled: false, workspaces: ['general', 'personal'], lastReadAt: null },
  ], events: [] });
}

export class MemoryStore {
  #state;
  #storage;
  #listeners = new Set();
  // Owner previews are transient, bounded, and contain IDs/revisions rather
  // than memory text. They are a stale-preview guard, not authentication.
  #profileSharingPreviews = new Map();

  constructor({ storage = globalThis.localStorage } = {}) {
    this.#storage = storage;
    let stored;
    try { stored = storage?.getItem(STORAGE_KEY); }
    catch (error) { throw new MemoryStoreError('STORAGE_UNAVAILABLE', '无法读取本地存储。', error); }
    if (stored !== undefined && stored !== null) {
      try { this.#state = validateSnapshot(JSON.parse(stored)); }
      catch (error) { throw new MemoryStoreError('STORAGE_INVALID', '本地数据格式有误，未自动覆盖原始数据。', error); }
    } else {
      this.#state = seed();
      this.#persist(this.#state);
    }
    // Older installations gain disabled client slots. ChatGPT export previews
    // migrate with their old grants paused until explicitly authorized.
    const migrated = this.getSnapshot();
    if (addMissingLocalClients(migrated)) { validateSnapshot(migrated); this.#persist(migrated); this.#state = migrated; }
  }

  #persist(next) {
    try { this.#storage?.setItem(STORAGE_KEY, JSON.stringify(next)); }
    catch (error) { throw new MemoryStoreError('STORAGE_UNAVAILABLE', '无法确认本次保存结果，请核对当前条目后再重试；不要重复新增。', error); }
  }

  #commit(next) {
    addMissingLocalClients(next);
    validateSnapshot(next);
    this.#persist(next);
    this.#state = next;
    for (const listener of this.#listeners) {
      try { listener(this.getSnapshot()); }
      catch (error) { console.error('MemoryStore subscriber failed', error); }
    }
  }

  #memory(state, memoryId) {
    const memory = state.memories.find((entry) => entry.id === memoryId);
    if (!memory) throw new MemoryStoreError('NOT_FOUND', '找不到这条记忆。');
    return memory;
  }

  #connection(state, connectionId) {
    const connection = state.connections.find((entry) => entry.id === connectionId);
    if (!connection) throw new MemoryStoreError('NOT_FOUND', '找不到这个平台。');
    return connection;
  }

  #patch(patch) {
    object(patch, MUTABLE_FIELDS, [], '记忆修改');
    return Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, field(key, value)]));
  }

  // This collection only receives genuinely new records created by a bound
  // host after setup. Reusing, editing or importing old records never grants
  // access, even when an old record's source and timestamp happen to match.
  #collectNewMemory(next, memory) {
    for (const connection of next.connections) {
      if (connection.setup && SETUP_PLATFORMS[connection.id] === memory.source.platform
          && connection.setup.categories.includes(memory.category)) {
        connection.memoryIds ??= [];
        if (!connection.memoryIds.includes(memory.id)) connection.memoryIds.push(memory.id);
      }
    }
  }

  getSnapshot() { return clone(this.#state); }

  getStorageStatus() { return readStorageStatus(this.#storage); }

  // Stage every operation against an isolated snapshot. Nothing reaches the
  // authority until commit, so a later validation or disk error cannot leave
  // the earlier entries of a capture batch behind.
  prepareTransaction(callback, options = {}) {
    if (typeof callback !== 'function') fail('批次操作必须是函数。');
    object(options, ['captureId', 'captureClient'], [], '批次选项');
    if (Reflect.ownKeys(options).some(key => !['captureId', 'captureClient'].includes(key))) fail('批次选项包含不支持的字段。');
    const { captureId, captureClient } = options;
    if (captureId !== undefined) string(captureId, '整理请求编号', 100);
    const auditing = Object.hasOwn(options, 'captureClient');
    if (auditing && (captureId === undefined || !Object.hasOwn(SETUP_PLATFORMS, captureClient))) fail('整理审计需要有效的请求和绑定客户端。');
    const previous = JSON.stringify(this.#state);
    const staged = new MemoryStore({ storage: { getItem: () => previous, setItem() {} } });
    const result = callback(staged);
    if (result && typeof result.then === 'function') fail('批次操作必须同步完成。');
    const next = staged.getSnapshot();
    if (captureId !== undefined) {
      const details = auditing ? readAudit(() => buildCaptureAudit({ captureId, captureClient, result, before: JSON.parse(previous), after: next })) : {};
      next.events.unshift({ id: `capture-${captureId}`, type: 'memory.captured', at: now(), ...details });
    }
    validateSnapshot(next);
    let committed = false;
    return {
      result: clone(result),
      commit: () => {
        if (committed) return clone(result);
        if (JSON.stringify(this.#state) !== previous) throw new MemoryStoreError('REVISION_CONFLICT', '资料已在批次准备后改变，请重试。');
        this.#commit(next);
        committed = true;
        return clone(result);
      },
    };
  }

  subscribe(listener) {
    if (typeof listener !== 'function') fail('订阅者必须是函数。');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  createMemory(input, options) {
    object(input, [...MUTABLE_FIELDS, 'source'], ['content'], '新记忆');
    let absentField;
    if (options !== undefined) {
      object(options, ['expectedAbsentProfileField'], undefined, '新建资料选项');
      if (Reflect.ownKeys(options).some(key => key !== 'expectedAbsentProfileField')) fail('新建资料选项包含不支持的字段。');
      absentField = PROFILE_FIELDS.find(field => field.key === options.expectedAbsentProfileField && !field.multi);
      if (!absentField || input.category !== '关于我' || parseProfileContent(input.content)?.key !== absentField.key) fail('新建资料的字段、分类与空值前置条件不一致。');
    }
    const memory = newMemory(input, { status: 'active', origin: 'manual', confirmed: true, action: 'created' });
    const next = this.getSnapshot();
    // The check and commit run synchronously against this authority. Owner
    // visibility includes a paused current record, which still occupies a field.
    if (absentField && profileSectionEntries(next.memories, absentField.section).some(entry => entry.field.key === absentField.key)) {
      throw new MemoryStoreError('REVISION_CONFLICT', '这项资料已在其他入口新增，请核对最新内容；输入尚未保存。');
    }
    next.memories.unshift(memory);
    this.#collectNewMemory(next, memory);
    next.events.unshift(event('memory.created', { memoryIds: [memory.id], revision: 1 }));
    this.#commit(next);
    return clone(memory);
  }

  // This path is called only for a statement explicitly authored by the user.
  // Interpretation belongs to the Codex skill, not a text-matching classifier.
  rememberMemory(input, options = {}) {
    object(input, ['content', 'category', 'workspace', 'source', 'memoryType'], ['content', 'source'], '本人陈述');
    object(options, ['id', 'expectedRevision'], [], '陈述修改选项');
    const content = string(input.content, '记忆内容').trim();
    const category = input.category === undefined ? '关于我' : field('category', input.category);
    try { profileItemForWrite(content, category); } catch (error) { fail(error.message); }
    if (input.workspace !== undefined) field('workspace', input.workspace);
    if (Object.hasOwn(input, 'memoryType')) field('memoryType', input.memoryType);
    validateSource(input.source);
    if (!AGENT_PLATFORMS.has(input.source.platform) || input.source.upstreamId !== undefined) fail('本人陈述必须来自当前受支持的 agent 用户对话，导入内容仍需审核。');
    const hasId = Object.hasOwn(options, 'id');
    if (hasId !== Object.hasOwn(options, 'expectedRevision')) fail('修改指定记忆需要 id 与 expectedRevision。');
    if (hasId && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1)) fail('修改版本号必须是正整数。');

    const next = this.getSnapshot();
    const real = m => !m.id.startsWith('demo-') && m.source.platform !== '演示对话';
    const current = m => real(m) && m.confirmed && ['active', 'paused'].includes(m.status)
      && (!m.validUntil || Date.parse(m.validUntil) > Date.now());
    const canConfirm = m => real(m) && !m.confirmed && ['pending', 'active', 'paused'].includes(m.status) && m.origin !== 'imported'
      && AGENT_PLATFORMS.has(m.source.platform) && !m.supersedes && m.category === category && m.content === content;
    let memory;
    if (hasId) {
      string(options.id, '记忆编号', 100);
      memory = this.#memory(next, options.id);
      if (memory.revision !== options.expectedRevision) throw new MemoryStoreError('REVISION_CONFLICT', '这条记忆已被修改，请核对最新内容。');
      if (!current(memory) && !canConfirm(memory)) fail('这条记忆不适合自动确认，请在面板中核对。');
    } else {
      let matches = next.memories.filter(m => current(m) && m.category === category && m.content === content);
      if (category === '关于我') {
        const parsed = parseProfileContent(content);
        const definition = parsed && PROFILE_FIELDS.find(f => f.key === parsed.key);
        if (definition && !definition.multi && definition.key !== 'milestone') {
          matches = next.memories.filter(m => current(m) && m.category === category && parseProfileContent(m.content)?.key === definition.key);
        }
        if (!matches.length && definition?.multi
          && next.memories.some(memory => current(memory) && profileItemCollision(memory, { content, category }))) {
          throw new MemoryStoreError('ITEM_TARGET_REQUIRED', '可能是已有副业或爱好的变化。请先读取原条目，再用准确 id 和 expectedRevision 更新；有歧义的内容可先保存为参考。');
        }
      }
      if (!matches.length) matches = next.memories.filter(canConfirm);
      if (matches.length > 1) throw new MemoryStoreError('AMBIGUOUS_MEMORY', '有多条可能对应的记忆，请在面板中选择要修改的条目。');
      memory = matches[0];
    }

    if (!memory) {
      memory = newMemory({ ...input, content, category, workspace: input.workspace ?? 'private' }, { status: 'active', origin: 'manual', confirmed: true, action: 'stated' });
      memory.history[0].source = clone(input.source);
      next.memories.unshift(memory);
      this.#collectNewMemory(next, memory);
    } else {
      if (Object.hasOwn(input, 'memoryType') && input.memoryType !== memory.memoryType && !hasId) fail('修改已有记忆的类型需要准确的 id 和 expectedRevision，请先读取当前版本。');
      const patch = { content, category, ...(input.workspace === undefined ? {} : { workspace: input.workspace }), ...(Object.hasOwn(input, 'memoryType') ? { memoryType: input.memoryType } : {}) };
      if (!memory.confirmed) {
        Object.assign(patch, { status: memory.status === 'paused' ? 'paused' : 'active', confirmed: true });
        if (Object.hasOwn(memory, 'reviewReasons')) patch.reviewReasons = [];
      }
      if (Object.entries(patch).every(([key, value]) => memory[key] === value)) return clone(memory);
      changeMemory(memory, patch, 'stated');
      memory.history.at(-1).source = clone(input.source);
    }
    next.events.unshift(event('memory.stated', { memoryIds: [memory.id], revision: memory.revision }));
    this.#commit(next);
    return clone(memory);
  }

  updateMemory(memoryId, patch, { expectedRevision } = {}) {
    const next = this.getSnapshot();
    const memory = this.#memory(next, memoryId);
    const validatedPatch = this.#patch(patch);
    if (Object.hasOwn(validatedPatch, 'memoryType') && validatedPatch.memoryType !== memory.memoryType && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) fail('修改记忆类型需要 expectedRevision 正整数，请先读取当前版本。');
    if (expectedRevision !== undefined && expectedRevision !== memory.revision) throw new MemoryStoreError('REVISION_CONFLICT', '这条记忆已被修改，请重新打开后再保存。');
    changeMemory(memory, validatedPatch, 'updated');
    next.events.unshift(event('memory.updated', { memoryIds: [memory.id], revision: memory.revision }));
    this.#commit(next);
    return clone(memory);
  }

  proposeMemory(input) {
    object(input, [...MUTABLE_FIELDS, 'source', 'origin', 'supersedes'], ['content'], '候选记忆');
    const memory = newMemory({ ...input, workspace: input.workspace ?? 'private' }, { status: 'pending', origin: input.origin ?? 'inferred', confirmed: false, action: 'proposed' });
    const next = this.getSnapshot();
    // Repeated extraction must not multiply a reference or undo a user's pause
    // or rejection. New concrete doubts can be attached to a usable reference;
    // evidence, type and authorization changes still require an explicit update.
    const duplicate = next.memories.find(previous => !previous.id.startsWith('demo-') && previous.source.platform !== '演示对话' && ['content', 'category', 'workspace', 'validUntil', 'supersedes'].every(key => (previous[key] ?? null) === (memory[key] ?? null))
      && JSON.stringify([...previous.audience].sort()) === JSON.stringify([...memory.audience].sort()));
    if (duplicate) {
      const reasons = [...new Set([...(duplicate.reviewReasons ?? []), ...(memory.reviewReasons ?? [])])];
      if (!duplicate.confirmed && isUsableMemory(duplicate) && reasons.length > (duplicate.reviewReasons?.length ?? 0)) {
        changeMemory(duplicate, { reviewReasons: reasons }, 'updated');
        duplicate.history.at(-1).source = clone(memory.source);
        next.events.unshift(event('memory.updated', { memoryIds: [duplicate.id], revision: duplicate.revision }));
        this.#commit(next);
      }
      return clone(duplicate);
    }
    next.memories.unshift(memory);
    this.#collectNewMemory(next, memory);
    next.events.unshift(event('memory.proposed', { memoryIds: [memory.id], revision: 1 }));
    this.#commit(next);
    return clone(memory);
  }

  confirmMemory(memoryId, patch = {}, options = {}) {
    object(options, ['expectedRevision', 'expectedAbsentProfileField'], [], '确认修改选项');
    const next = this.getSnapshot();
    const memory = this.#memory(next, memoryId);
    if (options.expectedRevision !== undefined && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1 || options.expectedRevision !== memory.revision)) throw new MemoryStoreError('REVISION_CONFLICT', '这条参考已变化，请读取最新资料后修改。');
    if (options.expectedAbsentProfileField !== undefined) {
      const field = PROFILE_FIELDS.find(field => field.key === options.expectedAbsentProfileField && !field.multi && field.key !== 'milestone');
      if (!field || parseProfileContent(patch.content ?? memory.content)?.key !== field.key) fail('确认字段与当前内容不一致。');
      if (profileSectionEntries(next.memories, field.section).some(entry => entry.field.key === field.key)) throw new MemoryStoreError('REVISION_CONFLICT', '这项资料已有本人确认值，请核对最新内容；输入已保留。');
    }
    if (memory.confirmed || !['pending', 'active', 'paused'].includes(memory.status)) fail('只能确认当前或已暂停的参考记忆。');
    const confirmation = { ...this.#patch(patch), status: memory.status === 'paused' ? 'paused' : 'active', confirmed: true };
    if (Object.hasOwn(memory, 'reviewReasons') || Object.hasOwn(confirmation, 'reviewReasons')) confirmation.reviewReasons = [];
    changeMemory(memory, confirmation, 'confirmed');
    if (memory.supersedes) {
      const previous = this.#memory(next, memory.supersedes);
      if (previous.status === 'active') {
        changeMemory(previous, { status: 'paused' }, 'superseded');
        next.events.unshift(event('memory.superseded', { memoryIds: [previous.id, memory.id], revision: previous.revision }));
      }
    }
    next.events.unshift(event('memory.confirmed', { memoryIds: [memory.id], revision: memory.revision }));
    this.#commit(next);
    return clone(memory);
  }

  rejectMemory(memoryId) {
    const next = this.getSnapshot();
    const memory = this.#memory(next, memoryId);
    if (memory.confirmed || !['pending', 'active', 'paused'].includes(memory.status)) fail('只能忽略当前或已暂停的参考记忆。');
    changeMemory(memory, { status: 'rejected', confirmed: false }, 'rejected');
    next.events.unshift(event('memory.rejected', { memoryIds: [memory.id], revision: memory.revision }));
    this.#commit(next);
    return clone(memory);
  }

  setMemoryStatus(memoryId, status) {
    enumeration(status, ['paused', 'active', 'expired'], '记忆状态');
    const next = this.getSnapshot();
    const memory = this.#memory(next, memoryId);
    if (memory.status === 'rejected') fail('已忽略的记忆不能直接恢复，请重新核对后添加。');
    const action = { paused: 'paused', active: 'activated', expired: 'expired' }[status];
    changeMemory(memory, { status }, action);
    next.events.unshift(event(`memory.${action}`, { memoryIds: [memory.id], revision: memory.revision }));
    this.#commit(next);
    return clone(memory);
  }

  deleteMemory(memoryId) {
    const next = this.getSnapshot();
    this.#memory(next, memoryId);
    next.memories = next.memories.filter((memory) => memory.id !== memoryId);
    for (const connection of next.connections) {
      if (connection.memoryIds) connection.memoryIds = connection.memoryIds.filter(id => id !== memoryId);
    }
    for (const memory of next.memories) {
      if (memory.supersedes === memoryId) delete memory.supersedes;
    }
    next.events.unshift(event('memory.deleted', { memoryIds: [memoryId] }));
    this.#commit(next);
    return true;
  }

  updateConnection(connectionId, patch) {
    object(patch, ['enabled', 'workspaces'], [], '平台授权');
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') fail('平台开关必须是布尔值。');
    if (patch.workspaces !== undefined) strings(patch.workspaces, '平台空间', WORKSPACES);
    const next = this.getSnapshot();
    const connection = this.#connection(next, connectionId);
    Object.assign(connection, clone(patch));
    if (connection.pausedLegacyGrants) {
      if (patch.enabled === true) connection.pausedLegacyGrants = { workspaces: false, newMemories: false };
      else if (Object.hasOwn(patch, 'workspaces')) connection.pausedLegacyGrants.workspaces = false;
    }
    next.events.unshift(event('connection.updated', { connectionId }));
    this.#commit(next);
    return clone(connection);
  }

  getAgentSetup(connectionId) {
    enumeration(connectionId, Object.keys(SETUP_PLATFORMS), '智能体');
    const connection = this.#connection(this.#state, connectionId);
    const real = memory => !memory.id.startsWith('demo-') && memory.source.platform !== '演示对话';
    const collection = new Set(connection.memoryIds ?? []);
    return { client: connectionId, mode: 'local', configured: Boolean(connection.setup),
      setup: connection.setup ? clone(connection.setup) : null,
      readableCount: this.getReadableMemories(connectionId).filter(real).length,
      newMemoryCount: this.#state.memories.filter(memory => collection.has(memory.id) && real(memory)).length };
  }

  updateAgentSetup(connectionId, input) {
    enumeration(connectionId, Object.keys(SETUP_PLATFORMS), '智能体');
    object(input, ['categories', 'autoCapture', 'readNew'], undefined, '首次设置');
    strings(input.categories, '保存主题', CATEGORIES, CATEGORIES.length);
    if (!input.categories.length) fail('请选择至少一个保存主题。');
    if (typeof input.autoCapture !== 'boolean' || typeof input.readNew !== 'boolean') fail('首次设置授权必须是布尔值。');
    const next = this.getSnapshot();
    const connection = this.#connection(next, connectionId);
    if (connection.mode !== 'local-agent') fail('此平台不是本地智能体，不能自动更改既有平台模式。');
    const categories = CATEGORIES.filter(category => input.categories.includes(category));
    const previous = connection.setup;
    if (previous && JSON.stringify(previous.categories) === JSON.stringify(categories)
        && previous.autoCapture === input.autoCapture && previous.readNew === input.readNew) return this.getAgentSetup(connectionId);
    const newReadGrant = input.readNew && previous?.readNew !== true;
    const at = now();
    connection.setup = { categories, autoCapture: input.autoCapture, readNew: input.readNew, createdAt: previous?.createdAt ?? at, updatedAt: at };
    connection.memoryIds ??= [];
    if (newReadGrant) {
      if (!connection.enabled) {
        connection.pausedLegacyGrants = { workspaces: true, newMemories: false };
        if (connection.profileSharing?.enabled) connection.profileSharing.enabled = false;
      } else if (connection.pausedLegacyGrants) connection.pausedLegacyGrants.newMemories = false;
      connection.enabled = true;
    }
    next.events.unshift(event('connection.updated', { connectionId }));
    this.#commit(next);
    return this.getAgentSetup(connectionId);
  }

  #profileSharingConnection(connectionId) {
    enumeration(connectionId, Object.keys(SETUP_PLATFORMS), '智能体');
    const connection = this.#connection(this.#state, connectionId);
    if (connection.mode !== 'local-agent') fail('主题共享仅支持本地智能体。');
    return connection;
  }

  #profileSharingSummary(connectionId, policy) {
    const records = this.#state.memories.filter(memory => includedInProfileSharing(memory, policy, connectionId));
    const confirmedCount = records.filter(memory => memory.confirmed).length;
    return { count: records.length, confirmedCount, referenceCount: records.length - confirmedCount,
      categoryCounts: Object.fromEntries(policy.categories.map(category => [category, records.filter(memory => memory.category === category).length])),
      memoryIds: records.map(memory => memory.id) };
  }

  #profileSharingFingerprint(connection, policy) {
    const versions = this.#state.memories.filter(memory => includedInProfileSharing(memory, policy, connection.id))
      .map(memory => [memory.id, memory.revision]).sort((a, b) => a[0].localeCompare(b[0]));
    return JSON.stringify({ policy, permissions: { enabled: connection.enabled, workspaces: connection.workspaces,
      setup: connection.setup ?? null, memoryIds: connection.memoryIds ?? [], profileSharing: connection.profileSharing ?? null,
      pausedLegacyGrants: connection.pausedLegacyGrants ?? { workspaces: false, newMemories: false } }, versions });
  }

  previewProfileSharing(connectionId, input) {
    const connection = this.#profileSharingConnection(connectionId), policy = profileSharingPolicy(input);
    const previewToken = id();
    while (this.#profileSharingPreviews.size >= 32) this.#profileSharingPreviews.delete(this.#profileSharingPreviews.keys().next().value);
    this.#profileSharingPreviews.set(previewToken, { client: connectionId, fingerprint: this.#profileSharingFingerprint(connection, policy) });
    return { client: connectionId, mode: 'local', enabled: connection.enabled,
      currentProfileSharing: clone(connection.profileSharing ?? { enabled: false, categories: [] }),
      pausedLegacyGrants: clone(connection.pausedLegacyGrants ?? { workspaces: false, newMemories: false }),
      willPauseLegacyGrants: policy.enabled && !connection.enabled,
      profileSharing: policy, ...this.#profileSharingSummary(connectionId, policy), previewToken };
  }

  updateProfileSharing(connectionId, input) {
    const connection = this.#profileSharingConnection(connectionId);
    object(input, ['enabled', 'categories', 'previewToken'], undefined, '主题共享提交');
    if (Reflect.ownKeys(input).some(key => !['enabled', 'categories', 'previewToken'].includes(key))) fail('主题共享提交包含不支持的字段。');
    const policy = profileSharingPolicy({ enabled: input.enabled, categories: input.categories });
    string(input.previewToken, '共享预览编号', 100);
    const preview = this.#profileSharingPreviews.get(input.previewToken);
    if (!preview || preview.client !== connectionId || preview.fingerprint !== this.#profileSharingFingerprint(connection, policy)) {
      throw new MemoryStoreError('REVISION_CONFLICT', '共享范围或资料已有变化，请重新预览后确认。');
    }
    if (JSON.stringify(connection.profileSharing) !== JSON.stringify(policy) || (policy.enabled && !connection.enabled)) {
      const next = this.getSnapshot(), target = this.#connection(next, connectionId);
      target.profileSharing = policy;
      if (policy.enabled && !connection.enabled) target.pausedLegacyGrants = { workspaces: true, newMemories: true };
      if (policy.enabled) target.enabled = true;
      next.events.unshift(event('connection.updated', { connectionId }));
      this.#commit(next);
    }
    this.#profileSharingPreviews.delete(input.previewToken);
    const current = this.#profileSharingConnection(connectionId);
    return { client: connectionId, mode: 'local', enabled: current.enabled,
      profileSharing: clone(current.profileSharing), setup: current.setup ? clone(current.setup) : null,
      pausedLegacyGrants: clone(current.pausedLegacyGrants ?? { workspaces: false, newMemories: false }),
      readableCount: this.getReadableMemories(connectionId).filter(realMemory).length,
      ...this.#profileSharingSummary(connectionId, current.profileSharing) };
  }

  getReadableMemories(connectionId) {
    const connection = this.#connection(this.#state, connectionId);
    if (!connection.enabled) return [];
    return clone(this.#state.memories.filter((memory) => isUsableMemory(memory)
      && ((!connection.pausedLegacyGrants?.workspaces && connection.workspaces.includes(memory.workspace))
        || (!connection.pausedLegacyGrants?.newMemories && connection.setup?.readNew === true && connection.memoryIds?.includes(memory.id))
        || includedInProfileSharing(memory, connection.profileSharing, connectionId))
      && (!memory.audience.length || memory.audience.includes(connectionId))));
  }

  recordRead(connectionId, memoryIds, options, selectedViews) {
    strings(memoryIds, '读取记忆编号', undefined, 5000);
    const readable = new Map(this.getReadableMemories(connectionId).map((memory) => [memory.id, memory]));
    if (memoryIds.some((memoryId) => !readable.has(memoryId))) fail('读取包含未授权、已暂停、已忽略或已到期的记忆。');
    const next = this.getSnapshot();
    const connection = this.#connection(next, connectionId);
    if (!connection.enabled) fail('平台当前未获授权。');
    if (options !== undefined && connection.mode !== 'local-agent') fail('读取审计详情仅支持 local-agent。');
    let auditedMemories = memoryIds.map(id => readable.get(id));
    if (selectedViews !== undefined) {
      if (!Array.isArray(selectedViews) || selectedViews.length !== memoryIds.length) fail('内部读取视图与记忆编号不一致。');
      auditedMemories = selectedViews.map((view, index) => {
        if (view?.id !== memoryIds[index]) fail('内部读取视图与记忆编号不一致。');
        try { return validateProfileAgeReadView(view, [...readable.values()], options) ?? readable.get(memoryIds[index]); }
        catch { fail('派生年龄的来源、授权或版本已有变化，请重新读取。'); }
      });
    }
    const readDetails = options === undefined ? undefined : readAudit(() => buildReadDetails(auditedMemories, options));
    connection.lastReadAt = now();
    next.events.unshift(event(connection.mode === 'local-agent' ? 'local.read' : 'demo.read', {
      connectionId, memoryIds: [...memoryIds], ...(readDetails === undefined ? {} : { readDetails }),
    }));
    this.#commit(next);
    return clone(connection);
  }

  exportData() { return this.getSnapshot(); }

  importData(input, { mode = 'merge' } = {}) {
    enumeration(mode, ['merge', 'replace'], '导入模式');
    let parsed = input;
    if (typeof input === 'string') {
      try { parsed = JSON.parse(input); }
      catch (error) { throw new MemoryStoreError('VALIDATION_ERROR', '导入文件不是有效 JSON。', error); }
    }
    const incoming = validateSnapshot(parsed);
    let next = incoming;
    if (mode === 'merge') {
      next = this.getSnapshot();
      for (const key of ['memories', 'connections', 'events']) {
        const entries = new Map(next[key].map((entry) => [entry.id, entry]));
        incoming[key].forEach((entry) => entries.set(entry.id, entry));
        next[key] = [...entries.values()];
      }
    }
    next.events.unshift(event('data.imported', { memoryIds: incoming.memories.map((memory) => memory.id) }));
    this.#commit(next);
    this.#profileSharingPreviews.clear();
    return this.getSnapshot();
  }

  importMem0Snapshot(records) {
    if (!Array.isArray(records) || records.length > 5000) fail('Mem0 快照必须是最多 5000 条记录的列表。');
    const next = this.getSnapshot();
    const existing = new Set(next.memories.filter((memory) => memory.source.platform === 'Mem0').map((memory) => memory.source.upstreamId).filter(Boolean));
    const imported = [];
    for (const record of records) {
      if (!isObject(record)) fail('Mem0 快照记录格式无效。');
      const content = string(record.content ?? record.memory, 'Mem0 记忆内容');
      const upstreamId = String(record.remoteId ?? record.id ?? '');
      if (!upstreamId.trim()) fail('Mem0 快照缺少上游记忆编号。');
      const suppliedExpiry = record.expiresAt === undefined ? record.expiration_date : record.expiresAt;
      const validUntil = suppliedExpiry === undefined || suppliedExpiry === null ? null : new Date(expiry(suppliedExpiry)).toISOString();
      if (existing.has(upstreamId)) continue;
      const suppliedDate = record.createdAt ?? record.created_at;
      const sourceAt = typeof suppliedDate === 'string' && Number.isFinite(Date.parse(suppliedDate)) ? new Date(suppliedDate).toISOString() : now();
      const category = Array.isArray(record.categories) ? record.categories.find((entry) => CATEGORIES.includes(entry)) : undefined;
      const memory = newMemory({ content, category: category ?? CATEGORIES[0], workspace: 'private', audience: [], validUntil, source: { label: 'Mem0 导入快照', excerpt: content, platform: 'Mem0', at: sourceAt, upstreamId } }, { status: 'pending', origin: 'imported', confirmed: false, action: 'imported' });
      next.memories.unshift(memory);
      imported.push(memory);
      existing.add(upstreamId);
    }
    if (imported.length) {
      next.events.unshift(event('mem0.imported', { memoryIds: imported.map((memory) => memory.id) }));
      this.#commit(next);
    }
    return clone(imported);
  }

  resetDemo() {
    const next = seed();
    next.events.unshift(event('demo.reset'));
    this.#commit(next);
    return this.getSnapshot();
  }
}
