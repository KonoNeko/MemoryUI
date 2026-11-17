const clients = ['codex', 'claude-code', 'workbuddy', 'chatgpt'];
const outcomes = ['created', 'updated', 'unchanged'];
const verifications = ['confirmed', 'reference'];
const reasons = ['existing_profile_conflict', 'existing_profile_item_conflict'];
const countKeys = ['total', 'confirmed', 'references', 'created', 'updated', 'unchanged', 'conflicts'];

export class CaptureAuditError extends Error {
  constructor(message) { super(message); this.name = 'CaptureAuditError'; this.code = 'VALIDATION_ERROR'; }
}
const fail = message => { throw new CaptureAuditError(message); };
const own = (value, key) => Object.hasOwn(value, key);

function object(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => !allowed.includes(key)) || required.some(key => !own(value, key))) fail('整理审计包含未知字段或缺少必要字段。');
}
function text(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) fail('整理审计编号无效。');
}
function integer(value, min = 0, max = 20) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('整理审计数量或版本无效。');
}
function array(value, maximum = 20) {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) fail('整理审计必须是有界连续列表。');
  for (let index = 0; index < value.length; index++) if (!own(value, index)) fail('整理审计列表不能有空位。');
}
function ids(value) {
  array(value);
  value.forEach(text);
  if (new Set(value).size !== value.length) fail('整理审计编号重复。');
}
const verification = memory => memory.confirmed === true ? 'confirmed' : 'reference';

function countsOf(entries) {
  return { total: entries.length,
    confirmed: entries.filter(entry => entry.verification === 'confirmed').length,
    references: entries.filter(entry => entry.verification === 'reference').length,
    created: entries.filter(entry => entry.outcome === 'created').length,
    updated: entries.filter(entry => entry.outcome === 'updated').length,
    unchanged: entries.filter(entry => entry.outcome === 'unchanged').length,
    conflicts: entries.filter(entry => own(entry, 'conflict')).length };
}

// This validates historical metadata only. Current records and child events
// may since have changed or been deleted; imports do not establish provenance.
export function validateCaptureDetails(details, memoryIds, connectionId, markerId) {
  if (!clients.includes(connectionId)) fail('整理审计必须记录绑定的客户端。');
  object(details, ['entries', 'counts', 'eventIds']);
  array(details.entries);
  ids(memoryIds);
  ids(details.eventIds);
  if (markerId !== undefined && details.eventIds.includes(markerId)) fail('整理审计不能把自己的提交标记列为子活动。');
  const firstSeen = [], previous = new Map();
  for (const entry of details.entries) {
    object(entry, ['id', 'revision', 'verification', 'outcome', 'conflict'], ['id', 'revision', 'verification', 'outcome']);
    text(entry.id);
    integer(entry.revision, 1, Number.MAX_SAFE_INTEGER);
    if (!verifications.includes(entry.verification) || !outcomes.includes(entry.outcome)
      || (own(entry, 'conflict') && !reasons.includes(entry.conflict))) fail('整理审计结果或冲突原因无效。');
    const earlier = previous.get(entry.id);
    if (earlier) {
      if (entry.outcome === 'created' || entry.revision < earlier.revision
        || (entry.outcome === 'unchanged' && (entry.revision !== earlier.revision || entry.verification !== earlier.verification))
        || (entry.outcome === 'updated' && entry.revision <= earlier.revision)) fail('整理审计的逐项版本与结果顺序不一致。');
    } else {
      firstSeen.push(entry.id);
      if (entry.outcome === 'created' && entry.revision !== 1) fail('新增条目的整理版本必须从 1 开始。');
    }
    previous.set(entry.id, entry);
  }
  if (JSON.stringify(firstSeen) !== JSON.stringify(memoryIds)) fail('整理审计条目与活动记忆编号不一致。');
  object(details.counts, countKeys);
  const actual = countsOf(details.entries);
  for (const key of countKeys) {
    integer(details.counts[key]);
    if (details.counts[key] !== actual[key]) fail('整理审计数量与逐项结果不一致。');
  }
  if (details.eventIds.length !== actual.created + actual.updated) fail('整理审计子活动数量必须与实际写入项数一致。');
  if (!details.entries.length && details.eventIds.length) fail('空整理不能包含写入子活动。');
}

// Called only from Store's isolated transaction, using Bridge's internal
// operation results. No HTTP/CLI input can provide these fields.
export function buildCaptureAudit({ captureId, captureClient, result, before, after }) {
  text(captureId);
  if (!clients.includes(captureClient)) fail('整理审计客户端无效。');
  object(result, ['results', 'auditEntries']);
  array(result.results); array(result.auditEntries);
  if (result.results.length !== result.auditEntries.length) fail('整理结果与审计逐项记录数量不一致。');
  const entries = result.auditEntries.map((entry, index) => {
    const actual = result.results[index];
    object(actual, ['id', 'kind', 'requestedKind', 'evidenceKind', 'outcome', 'readableByCurrentClient', 'reason'], ['id', 'kind', 'requestedKind', 'evidenceKind', 'outcome', 'readableByCurrentClient']);
    if (!['explicit', 'reference'].includes(actual.kind) || !['explicit', 'reference'].includes(actual.requestedKind)
      || !['user_quote', 'host_summary', 'inference'].includes(actual.evidenceKind) || typeof actual.readableByCurrentClient !== 'boolean'
      || (own(actual, 'reason') && !reasons.includes(actual.reason))) fail('内部整理回执格式无效。');
    object(entry, ['id', 'revision', 'verification', 'outcome', 'conflict'], ['id', 'revision', 'verification', 'outcome']);
    if (entry.id !== actual.id || entry.verification !== (actual.kind === 'explicit' ? 'confirmed' : 'reference')
      || entry.outcome !== actual.outcome || entry.conflict !== actual.reason || own(entry, 'conflict') !== own(actual, 'reason')) fail('整理审计必须匹配实际逐项回执。');
    return { id: entry.id, revision: entry.revision, verification: entry.verification, outcome: entry.outcome,
      ...(own(entry, 'conflict') ? { conflict: entry.conflict } : {}) };
  });
  const memoryIds = [...new Set(entries.map(entry => entry.id))];
  const previousEvents = new Set(before.events.map(event => event.id));
  const children = after.events.filter(event => !previousEvents.has(event.id));
  if (children.some(event => !event.type.startsWith('memory.') || event.type === 'memory.captured'
    || event.memoryIds?.some(id => !memoryIds.includes(id)))) fail('整理事务包含未对应逐项结果的子活动。');
  const unmatched = [...children];
  for (const entry of entries) {
    if (entry.outcome === 'unchanged') continue;
    const index = unmatched.findIndex(event => event.memoryIds?.length === 1 && event.memoryIds[0] === entry.id && event.revision === entry.revision);
    if (index < 0) fail('整理逐项版本必须对应本次实际写入的唯一子活动。');
    unmatched.splice(index, 1);
  }
  if (unmatched.length) fail('整理事务不能遗漏实际写入的子活动。');
  const captureDetails = { entries, counts: countsOf(entries), eventIds: children.map(event => event.id) };
  validateCaptureDetails(captureDetails, memoryIds, captureClient, `capture-${captureId}`);
  const current = new Map(before.memories.map(memory => [memory.id, { revision: memory.revision, verification: verification(memory) }]));
  const affected = new Map();
  for (const entry of entries) {
    const previous = current.get(entry.id);
    if ((entry.outcome === 'created' && (previous || entry.revision !== 1))
      || (entry.outcome === 'updated' && (!previous || entry.revision <= previous.revision))
      || (entry.outcome === 'unchanged' && (!previous || entry.revision !== previous.revision || entry.verification !== previous.verification))) fail('整理审计结果与事务前记录版本不一致。');
    current.set(entry.id, entry);
    affected.set(entry.id, entry);
  }
  for (const [id, entry] of affected) {
    const memory = after.memories.find(memory => memory.id === id);
    if (!memory || memory.revision !== entry.revision || verification(memory) !== entry.verification) fail('整理审计最后版本与实际待提交记录不一致。');
  }
  return { connectionId: captureClient, memoryIds, captureDetails };
}
