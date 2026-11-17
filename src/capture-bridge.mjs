import { createHash, randomUUID } from 'node:crypto';
import { CATEGORIES } from './memory-store.js';
import { MEMORY_TYPES } from './memory-types.js';
import { REVIEW_REASONS } from './memory-policy.js';
import { PROFILE_FIELDS, parseProfileContent, parseProfileItem } from './profile-model.js';
import { equivalentProfileMeasurement } from './profile-equivalence.mjs';
import { profileItemCollision, profileItemForWrite } from './profile-item-identity.mjs';
import { getDataDirectory } from './server-storage.mjs';
import { createAtomicFileStorage } from './atomic-file-storage.mjs';
import { readStorageStatus } from './storage-status.mjs';

export const CAPTURE_CLIENTS = Object.freeze({ codex: 'Codex', 'claude-code': 'Claude Code', workbuddy: 'WorkBuddy', chatgpt: 'ChatGPT' });
const TTL_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(value).digest('hex');

export class CaptureBridgeError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'CaptureBridgeError'; this.code = code; this.status = status; }
}
const fail = (message, code = 'CAPTURE_VALIDATION_ERROR', status = 400) => { throw new CaptureBridgeError(code, message, status); };
function object(value, allowed, required = allowed) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('整理数据包含未知字段或缺少必要字段。');
}
function text(value, label, maximum = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail(`${label}必须为 1–${maximum} 个字符的非空文本。`);
  return value.trim();
}
function client(value) {
  if (!Object.hasOwn(CAPTURE_CLIENTS, value)) fail('请选择 ChatGPT、WorkBuddy、Codex 或 Claude Code。');
  return value;
}
function singleProfile(content, category) {
  if (category !== '关于我') return null;
  const parsed = parseProfileContent(content);
  const field = parsed && PROFILE_FIELDS.find(entry => entry.key === parsed.key);
  return field && !field.multi && field.key !== 'milestone' ? field.key : null;
}
function activeConfirmed(memory, clock) {
  return memory.confirmed && ['active', 'paused'].includes(memory.status) && (!memory.validUntil || Date.parse(memory.validUntil) > clock)
    && !memory.id.startsWith('demo-') && memory.source.platform !== '演示对话';
}

// Separate, private local state. Never place requests or their quoted excerpts
// under the source tree. A supplied null storage is genuinely memory-only.
export function createCaptureRequestStorage({ root, env = process.env, directory = getDataDirectory(root, env), fileSystem }) {
  return createAtomicFileStorage({ directory, basename: 'capture-requests.json', fileSystem,
    messages: { unreadable: 'Invalid capture request file', tooLarge: 'Capture requests exceed storage limit', changed: 'Capture requests changed outside this service' } });
}

export class CaptureBridge {
  #storage;
  #state = { version: 1, requests: [] };
  #store;
  #clock;
  constructor({ getStore, storage = null, clock = () => Date.now() }) {
    this.#store = getStore;
    this.#storage = storage;
    this.#clock = clock;
  }
  getStorageStatus() { return readStorageStatus(this.#storage); }
  #load() {
    if (!this.#storage) return;
    try {
      const serialized = this.#storage.getItem('capture-requests');
      if (serialized == null) { this.#state = { version: 1, requests: [] }; return; }
      const input = JSON.parse(serialized);
      if (input.version !== 1 || !Array.isArray(input.requests) || input.requests.length > 1000) throw new Error('Invalid state');
      const ids = new Set();
      for (const entry of input.requests) {
        const request = entry.request;
        if (!request || !UUID.test(request.id) || ids.has(request.id) || !Object.hasOwn(CAPTURE_CLIENTS, request.client)
          || !['current_conversation', 'codex_native_memory', 'profile_onboarding', 'prompt_event'].includes(request.scope) || !['pending', 'completed', 'cancelled', 'expired'].includes(request.status)
          || !Number.isFinite(Date.parse(request.createdAt)) || !Number.isFinite(Date.parse(request.expiresAt))
          || !Array.isArray(request.categories) || !request.categories.length || request.categories.some(category => !CATEGORIES.includes(category))) throw new Error('Invalid request');
        ids.add(request.id);
      }
      this.#state = input;
    } catch { fail('无法读取整理请求文件，原始文件未被覆盖。', 'CAPTURE_STORAGE_INVALID', 503); }
  }
  #save(next) {
    try { this.#storage?.setItem('capture-requests', JSON.stringify(next)); }
    catch { fail('无法保存整理请求，请重试；没有自动重置资料。', 'CAPTURE_STORAGE_UNAVAILABLE', 503); }
    this.#state = next;
  }
  #find(id) {
    if (typeof id !== 'string' || !UUID.test(id)) fail('整理请求编号无效。');
    const entry = this.#state.requests.find(entry => entry.request.id === id);
    if (!entry) fail('找不到这个整理请求。', 'CAPTURE_NOT_FOUND', 404);
    return entry;
  }
  #public(entry) {
    const request = clone(entry.request);
    if (request.status === 'pending' && Date.parse(request.expiresAt) <= this.#clock()) request.status = 'expired';
    return request;
  }
  #bind(entry, requestedClient) {
    client(requestedClient);
    if (entry.request.client !== requestedClient) fail('此整理请求只授权给指定智能体。', 'CAPTURE_CLIENT_MISMATCH', 403);
  }
  #scope(entry, trustedOptions = {}) {
    const scope = trustedOptions.sourceScope ?? 'current_conversation';
    if (!['current_conversation', 'codex_native_memory', 'profile_onboarding', 'prompt_event'].includes(scope) || entry.request.scope !== scope) fail('此任务属于另一种资料来源，请使用对应的导入流程。', 'CAPTURE_SCOPE_MISMATCH', 403);
  }
  #pending(entry) {
    if (Date.parse(entry.request.expiresAt) <= this.#clock()) fail('整理授权已过期，请在面板重新创建。', 'CAPTURE_EXPIRED', 410);
    if (entry.request.status !== 'pending') fail('此整理请求已经完成或取消。', 'CAPTURE_NOT_PENDING', 409);
  }
  template(request) {
    return {
      version: 1, scope: 'current_conversation', categories: [...request.categories],
      evidenceKinds: ['user_quote', 'host_summary', 'inference'],
      entrySchema: {
        kind: ['explicit', 'reference'], evidenceKind: ['user_quote', 'host_summary', 'inference'],
        content: { type: 'string', minLength: 1, maxLength: 4000 }, category: [...request.categories],
        excerpt: { type: 'string', minLength: 1, maxLength: 4000, description: '保留用户原句或明确标注的宿主摘要；不要把模板本身当作用户资料。' },
        memoryType: { optional: true, values: Object.keys(MEMORY_TYPES) },
        reviewReasons: { optional: true, referenceOnly: true, values: Object.keys(REVIEW_REASONS) },
        target: { optional: true, explicitOnly: true, profileItemsOnly: true, required: ['id', 'expectedRevision'], additionalProperties: false, id: { type: 'string', minLength: 1, maxLength: 100 }, expectedRevision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, description: '先recall/show读取当前获授权的同一副业或爱好，沿用其ID和版本，只更新本次明确变化的内容；新一段经历不使用target。' },
      },
      profileFields: PROFILE_FIELDS.map(field => ({ key: field.key, label: field.label, prefix: `${field.label}：`, multi: Boolean(field.multi || field.key === 'milestone') })),
      profileItemFormat: {
        fields: ['副业', '爱好'],
        content: '<副业或爱好>：<单项名称>\n开始时间：<YYYY、YYYY-MM 或 YYYY-MM-DD；未知留空>\n结束时间：<同上；未知留空>\n阶段：<进行中、暂时搁置、已结束或未注明>\n详细说明：<用户提供的其他限定；没有留空>',
        rules: [
          '每项独立记录；名称只写名称，时间、阶段和说明分别放到对应行，不用逗号段落替代这些字段。',
          '只依据本次可见原文填时间与阶段，保持日期精度；没有结束时间不等于进行中，未知阶段写未注明。',
          '“2025年3月”可以写2025-03，“2025年”写2025；“明年春天”等相对或模糊日期只保留在详细说明，不猜具体年月。',
          'excerpt 仍是消息的连续原文，不将结构化后的 content 冒充用户原句；旧自由文本不自动拆分或迁移。',
        ],
      },
      rules: [
        '只整理本任务中宿主当前可见的用户对话；不声称可读取账户全部历史、隐藏记忆或其他会话。',
        '只整理授权 categories 内与用户本人有关的信息。没有相关资料时提交 entries: []；未提供的字段不猜测、不填占位值。',
        '仅用户本人的明确原句可用 kind: explicit + evidenceKind: user_quote；excerpt 必须保留该原句，不能把模型自己的话当成用户证据。',
        '宿主摘要与推断分别用 evidenceKind: host_summary 或 inference，并且 kind 必须为 reference；参考默认可用但不等于本人确认。',
        '关于我条目使用 profileFields 的 prefix，单条记录一个字段；副业、爱好、人生经历可各有多项。已存在的不同单值不会被静默覆盖，而会降为冲突参考。',
        '副业和爱好遵循 profileItemFormat 的逐行格式，一项一条；名称、日期、阶段和说明分开，未提供的时间留空、阶段写未注明。',
        '过去任职、旧住址或仅限过去某次的身体测量使用人生经历并保留时间，不把过去值写成当前职业、居住地或身体属性；明确的未来计划保留计划措辞。',
        '同一副业或爱好的本次明确变化：先recall再show读完整旧内容，保留未变的日期/阶段/说明，用target:{id,expectedRevision}精确更新。同名不等于同一项；新一段、回顾历史、主体不清或多个候选不使用target，有歧义先作参考。无target的同名不同内容且起始区间重叠或未知会保留为冲突参考。',
        '每批 0–20 条；content 和 excerpt 各不超过 4000 字，提交 JSON 文件不超过 120 KiB（UTF-8）。不要提交 workspace、audience、source、id、platform 或授权范围以外的字段。',
        'memoryType 可省略，或选择 semantic、episodic、procedural、working、unclassified。reviewReasons 只允许参考条目携带 conflict、weak_evidence、possibly_outdated。',
        '新资料保存到私密空间，保持用户已有读取授权；仅首次设置中已授权的新增记忆集合会允许绑定客户端读取，以保存回执为准。不要摘录密钥、密码或用户要求不保存的内容。',
      ],
      example: { requestId: request.id, version: 1, entries: [] },
    };
  }
  list() { this.#load(); return { requests: this.#state.requests.filter(entry => entry.request.scope === 'current_conversation').map(entry => this.#public(entry)) }; }
  create(input, trustedOptions = {}) {
    object(input, ['client', 'categories', 'scope'], ['client', 'categories']);
    object(trustedOptions, ['sourceScope'], []);
    if (trustedOptions.sourceScope !== undefined && !['codex_native_memory', 'profile_onboarding', 'prompt_event'].includes(trustedOptions.sourceScope)) fail('内部资料来源无效。');
    client(input.client);
    if (input.scope !== undefined && input.scope !== 'current_conversation') fail('仅支持当前可见对话范围。');
    if (!Array.isArray(input.categories) || !input.categories.length || input.categories.length > CATEGORIES.length
      || new Set(input.categories).size !== input.categories.length || input.categories.some(category => !CATEGORIES.includes(category))) fail('请选择至少一个不重复的记忆分类。');
    this.#load();
    if (this.#state.requests.length >= 1000) fail('整理请求数量已达到本机上限。', 'CAPTURE_LIMIT', 409);
    const at = this.#clock();
    const request = { id: randomUUID(), client: input.client, categories: [...input.categories], scope: trustedOptions.sourceScope ?? 'current_conversation', status: 'pending', createdAt: new Date(at).toISOString(), expiresAt: new Date(at + TTL_MS).toISOString() };
    this.#save({ ...this.#state, requests: [{ request }, ...this.#state.requests] });
    return { request: clone(request), template: this.template(request) };
  }
  get(id, requestedClient, trustedOptions = {}) {
    this.#load();
    const entry = this.#find(id);
    this.#bind(entry, requestedClient);
    this.#scope(entry, trustedOptions);
    return { request: this.#public(entry), template: this.template(entry.request) };
  }
  cancel(id, input = {}) {
    object(input, [], []);
    this.#load();
    const entry = this.#find(id);
    this.#scope(entry);
    this.#pending(entry);
    // A prepared write that reached the authority cannot subsequently be
    // cancelled. Its durable marker wins, even after a process interruption.
    if (entry.submission && this.#marker(id)) fail('资料已经保存，不能取消已提交的整理请求。', 'CAPTURE_ALREADY_COMMITTED', 409);
    const next = clone(this.#state), target = next.requests.find(item => item.request.id === id);
    target.request.status = 'cancelled'; target.request.cancelledAt = new Date(this.#clock()).toISOString();
    delete target.submission;
    this.#save(next);
    return { request: this.#public(target) };
  }
  #marker(id) { return this.#store().getSnapshot().events.some(event => event.id === `capture-${id}` && event.type === 'memory.captured'); }
  #validate(input, request) {
    object(input, ['client', 'version', 'entries']);
    this.#bind({ request }, input.client);
    if (input.version !== 1 || !Array.isArray(input.entries) || input.entries.length > 20) fail('整理模板必须为 version 1，entries 为最多 20 条的列表。');
    const singleFields = new Map(), targetIds = new Set();
    const entries = input.entries.map(entry => {
      object(entry, ['kind', 'evidenceKind', 'content', 'category', 'memoryType', 'excerpt', 'reviewReasons', 'target'], ['kind', 'evidenceKind', 'content', 'category', 'excerpt']);
      if (!['explicit', 'reference'].includes(entry.kind) || !['user_quote', 'host_summary', 'inference'].includes(entry.evidenceKind)) fail('记忆确认级别或证据类型无效。');
      if (entry.kind === 'explicit' && (entry.evidenceKind !== 'user_quote' || Object.hasOwn(entry, 'reviewReasons'))) fail('明确记忆仅支持用户原句，不能携带推断或核对标记。');
      if (!request.categories.includes(entry.category)) fail('这条记忆超出了本次授权分类。', 'CAPTURE_SCOPE_VIOLATION', 403);
      if (Object.hasOwn(entry, 'memoryType') && !Object.hasOwn(MEMORY_TYPES, entry.memoryType)) fail('记忆类型无效。');
      if (Object.hasOwn(entry, 'reviewReasons') && (!Array.isArray(entry.reviewReasons) || entry.reviewReasons.length > Object.keys(REVIEW_REASONS).length || new Set(entry.reviewReasons).size !== entry.reviewReasons.length || entry.reviewReasons.some(reason => !Object.hasOwn(REVIEW_REASONS, reason)))) fail('核对原因无效。');
      const content = text(entry.content, '记忆内容');
      let profileItem;
      // Validate without rewriting the text or inferring missing legacy facts.
      try { profileItem = profileItemForWrite(content, entry.category); }
      catch (error) { fail(error.message); }
      if (Object.hasOwn(entry, 'target')) {
        object(entry.target, ['id', 'expectedRevision']);
        if (entry.kind !== 'explicit' || entry.evidenceKind !== 'user_quote' || !profileItem) fail('只有明确本人原句的副业或爱好可指定更新目标。');
        text(entry.target.id, '目标记忆编号', 100);
        if (!Number.isSafeInteger(entry.target.expectedRevision) || entry.target.expectedRevision < 1) fail('目标版本必须为正整数。');
        if (targetIds.has(entry.target.id)) fail('同一批次不能重复更新同一个目标。');
        targetIds.add(entry.target.id);
      }
      text(entry.excerpt, '原文依据');
      const excerpt = entry.excerpt;
      const key = singleProfile(content, entry.category);
      if (key && singleFields.has(key) && singleFields.get(key) !== content
        && !equivalentProfileMeasurement({ content: singleFields.get(key), category: entry.category }, { content, category: entry.category })) fail('同一批次包含同一个人字段的不同值，请先整理冲突，再提交整批。');
      if (key) singleFields.set(key, content);
      return { kind: entry.kind, evidenceKind: entry.evidenceKind, content, category: entry.category, excerpt,
        ...(Object.hasOwn(entry, 'memoryType') ? { memoryType: entry.memoryType } : {}),
        ...(Object.hasOwn(entry, 'target') ? { target: { id: entry.target.id, expectedRevision: entry.target.expectedRevision } } : {}),
        ...(Object.hasOwn(entry, 'reviewReasons') ? { reviewReasons: [...entry.reviewReasons].sort() } : {}) };
    });
    return { client: input.client, version: 1, entries };
  }
  #completed(id, receipt) {
    const next = clone(this.#state), target = next.requests.find(entry => entry.request.id === id);
    target.request.status = 'completed'; target.request.completedAt ??= new Date(this.#clock()).toISOString(); target.request.counts = receipt.counts;
    target.submission.receipt = { ...receipt, request: clone(target.request) };
    this.#save(next);
    return clone(target.submission.receipt);
  }
  submit(id, input, trustedOptions = {}) {
    this.#load();
    const entry = this.#find(id);
    this.#scope(entry, trustedOptions);
    const payload = this.#validate(input, entry.request);
    // Only an internal source adapter may supply source labels. They are never
    // accepted as HTTP/MCP entry fields and participate in replay identity.
    const sourceLabels = trustedOptions.sourceLabels;
    const receivedAt = trustedOptions.currentUserUpdateAt;
    if (Object.keys(trustedOptions).some(key => !['sourceLabels', 'sourceScope', 'currentUserUpdate', 'currentUserUpdateAt'].includes(key))
      || (trustedOptions.currentUserUpdate !== undefined && (trustedOptions.currentUserUpdate !== true || entry.request.scope !== 'prompt_event'))
      || (trustedOptions.currentUserUpdate === true && (!Array.isArray(receivedAt) || receivedAt.length !== payload.entries.length || receivedAt.some(at => !Number.isFinite(Date.parse(at)))))
      || (sourceLabels !== undefined && (!Array.isArray(sourceLabels)
      || sourceLabels.length !== payload.entries.length || sourceLabels.some(label => typeof label !== 'string' || !label.trim() || label.length > 300)))) fail('内部来源标签无效。');
    const payloadHash = digest(JSON.stringify(trustedOptions.currentUserUpdate ? { payload, sourceLabels, currentUserUpdate: true, receivedAt } : sourceLabels === undefined ? payload : { payload, sourceLabels }));
    if (entry.submission && entry.submission.payloadHash !== payloadHash) fail('此请求已提交过不同内容，请创建新的整理授权。', 'CAPTURE_PAYLOAD_CONFLICT', 409);
    if (entry.request.status === 'completed') return clone(entry.submission.receipt);
    if (entry.submission && this.#marker(id)) return this.#completed(id, entry.submission.receipt);
    this.#pending(entry);
    const store = this.#store();
    const baseFingerprint = digest(JSON.stringify(store.getSnapshot()));
    // Explicit reset/replace can remove an event marker. Never interpret a
    // changed authority with no marker as permission to replay old memories.
    if (entry.submission && entry.submission.baseFingerprint !== baseFingerprint) fail('资料已在提交恢复前发生变化，请取消此请求并重新授权整理。', 'CAPTURE_STATE_CHANGED', 409);
    const prepared = store.prepareTransaction(staged => {
      const results = [], auditEntries = [];
      for (const [itemIndex, item] of payload.entries.entries()) {
        const previous = staged.getSnapshot().memories;
        let target;
        if (item.target) {
          const connection = staged.getSnapshot().connections.find(connection => connection.id === payload.client);
          target = previous.find(memory => memory.id === item.target.id);
          if (!connection?.enabled || connection.mode !== 'local-agent' || !target || target.status !== 'active'
            || !activeConfirmed(target, this.#clock()) || !staged.getReadableMemories(payload.client).some(memory => memory.id === target.id)) {
            fail('目标当前不可读取或不适合自动更新，请重新读取条目；没有覆盖资料。', 'CAPTURE_TARGET_UNAVAILABLE', 403);
          }
          if (target.revision !== item.target.expectedRevision) fail('目标版本已变化，请重新读取完整内容后再整理。', 'CAPTURE_TARGET_CHANGED', 409);
          const beforeItem = target.category === '关于我' ? parseProfileItem(target.content) : null;
          if (!beforeItem || beforeItem.key !== parseProfileItem(item.content)?.key) fail('更新目标必须属于同一副业或爱好字段。', 'CAPTURE_TARGET_MISMATCH');
          if (Object.hasOwn(item, 'memoryType') && item.memoryType !== target.memoryType) fail('批量目标更新保留原记忆类型；更改类型请使用独立修改入口。', 'CAPTURE_TARGET_TYPE_CHANGE');
        }
        const key = singleProfile(item.content, item.category);
        const existing = previous.filter(memory => activeConfirmed(memory, this.#clock()) && memory.category === item.category
          && (key ? singleProfile(memory.content, memory.category) === key : memory.content === item.content));
        const sameFact = memory => memory.content === item.content || equivalentProfileMeasurement(memory, item);
        const itemConflict = !target && !existing.length && previous.some(memory => activeConfirmed(memory, this.#clock()) && profileItemCollision(memory, item));
        const scalarConflict = Boolean(key && existing.some(memory => !sameFact(memory)));
        const currentCorrection = trustedOptions.currentUserUpdate === true && item.kind === 'explicit' && Boolean(key) && existing.length <= 1
          && !existing.some(memory => Date.parse(memory.updatedAt) > Date.parse(receivedAt[itemIndex]));
        const conflict = !target && ((!currentCorrection && scalarConflict) || itemConflict);
        // Reformatting a known measurement is not a new user correction. Reuse
        // only a unique confirmed record; never canonicalize its content, attach
        // a different quotation, expand grants or arbitrarily choose among IDs.
        const equivalent = !conflict && existing.length === 1 && equivalentProfileMeasurement(existing[0], item) ? existing[0] : null;
        const kind = conflict ? 'reference' : item.kind;
        const source = { label: sourceLabels?.[itemIndex] ?? `${CAPTURE_CLIENTS[payload.client]} · 模板整理 · ${item.evidenceKind === 'user_quote' ? '用户原句' : item.evidenceKind === 'host_summary' ? '宿主摘要' : '推断参考'}`, excerpt: item.excerpt, platform: CAPTURE_CLIENTS[payload.client], at: new Date(this.#clock()).toISOString() };
        const inputMemory = { content: item.content, category: item.category, source };
        // Reusing a confirmed value cannot silently change its taxonomy.
        if (Object.hasOwn(item, 'memoryType') && !(kind === 'explicit' && existing.length)) inputMemory.memoryType = item.memoryType;
        if (kind === 'reference') {
          inputMemory.workspace = 'private';
          inputMemory.reviewReasons = [...new Set([...(item.reviewReasons ?? []), ...(conflict ? ['conflict'] : [])])];
        }
        const memory = target ? staged.rememberMemory(inputMemory, item.target) : equivalent || (kind === 'explicit' ? staged.rememberMemory(inputMemory) : staged.proposeMemory(inputMemory));
        const before = previous.find(previous => previous.id === memory.id);
        const connection = staged.getSnapshot().connections.find(connection => connection.id === payload.client);
        const readableByCurrentClient = Boolean(connection?.enabled && connection.mode === 'local-agent'
          && staged.getReadableMemories(payload.client).some(readable => readable.id === memory.id));
        const result = { id: memory.id, kind: memory.confirmed ? 'explicit' : 'reference', requestedKind: item.kind, evidenceKind: item.evidenceKind,
          outcome: !before ? 'created' : before.revision === memory.revision ? 'unchanged' : 'updated',
          readableByCurrentClient,
          ...(conflict ? { reason: itemConflict ? 'existing_profile_item_conflict' : 'existing_profile_conflict' } : {}) };
        results.push(result);
        auditEntries.push({ id: memory.id, revision: memory.revision,
          verification: memory.confirmed ? 'confirmed' : 'reference', outcome: result.outcome,
          ...(result.reason ? { conflict: result.reason } : {}) });
      }
      return { results, auditEntries };
    }, { captureId: id, captureClient: entry.request.client });
    const results = prepared.result.results;
    const counts = { total: results.length, confirmed: results.filter(result => result.kind === 'explicit').length, references: results.filter(result => result.kind === 'reference').length,
      created: results.filter(result => result.outcome === 'created').length, updated: results.filter(result => result.outcome === 'updated').length, unchanged: results.filter(result => result.outcome === 'unchanged').length };
    const receipt = { request: clone(entry.request), results, counts, notice: '已按本次授权保存。新资料位于私密空间，既有空间授权不变；若已启用首次设置中的新增记忆读取，仅绑定客户端可读取本次起新建且主题匹配的记录，以逐条回执为准。未核实内容作为参考，冲突资料不会覆盖个人主页。来源依据由宿主提供，服务不声称核实了宿主实际可见的对话。' };
    const next = clone(this.#state), target = next.requests.find(entry => entry.request.id === id);
    target.submission = { payloadHash, baseFingerprint, receipt };
    this.#save(next);
    // Commit once, including the durable request marker. If completing the
    // separate request receipt fails afterwards, the next identical retry can
    // finish the receipt without ever running the batch a second time.
    prepared.commit();
    return this.#completed(id, receipt);
  }
}
