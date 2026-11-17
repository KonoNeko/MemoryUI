import { CATEGORIES } from './memory-taxonomy.mjs';
import { PROFILE_FIELDS } from './profile-model.js';
import { MEMORY_TYPES, memoryTypeOf } from './memory-types.js';
import { memoryRecallFields } from './recall-intent.mjs';
import { normalizeRecallScope, recallScopeAllows } from './recall-scope.mjs';
import { RETRIEVAL_METHOD } from './task-recall.mjs';

const fieldKeys = [...PROFILE_FIELDS.map(field => field.key), 'communication'];
const memoryTypes = ['all', ...Object.keys(MEMORY_TYPES)];
const recallKeys = ['kind', 'method', 'memoryType', 'limit', 'budgetChars', 'returnedChars', 'scope'];
const contextKeys = ['kind', 'memoryType'];
const derivedKeys = ['categories', 'fields', 'records', 'confirmedCount', 'referenceCount'];

export class ReadAuditError extends Error {
  constructor(message) { super(message); this.name = 'ReadAuditError'; this.code = 'VALIDATION_ERROR'; }
}
const fail = message => { throw new ReadAuditError(message); };
const own = (value, key) => Object.hasOwn(value, key);

function exactObject(value, allowed, required, label) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label}必须是普通对象。`);
  if (Reflect.ownKeys(value).some(key => !allowed.includes(key)) || required.some(key => !own(value, key))) fail(`${label}字段无效或缺失。`);
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label}必须是 ${minimum}–${maximum} 的整数。`);
}

function list(value, allowed, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) fail(`${label}必须是连续列表。`);
  const seen = new Set();
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    if (!own(value, index) || typeof item !== 'string' || !item.trim() || item.length > 100 || (allowed && !allowed.includes(item)) || seen.has(item)) fail(`${label}包含重复或未知值。`);
    seen.add(item);
  }
}

function normalizeScope(value) {
  try { return normalizeRecallScope(value); }
  catch { fail('读取审计的 scope 无效。'); }
}

// Only server-produced query settings enter here. IDs, record versions, field
// indexes and counts are always derived below from the actual readable records.
function normalizeOptions(options, { historical = false } = {}) {
  const kind = options?.kind;
  if (!['recall', 'context', 'show'].includes(kind)) fail('读取审计 kind 无效。');
  const keys = kind === 'recall' ? recallKeys : contextKeys;
  exactObject(options, keys, kind === 'recall' ? recallKeys.filter(key => key !== 'scope') : ['kind'], '读取审计参数');
  if (kind !== 'recall') {
    if (own(options, 'memoryType') && options.memoryType !== 'all') fail('context/show 读取审计仅支持 memoryType: all。');
    return { kind, memoryType: 'all' };
  }
  const validMethod = historical
    ? typeof options.method === 'string' && options.method.length <= 64 && /^[a-z]/.test(options.method) && !/[^a-z0-9-]/.test(options.method)
    : options.method === RETRIEVAL_METHOD;
  if (!validMethod || !memoryTypes.includes(options.memoryType)) fail('召回方式或记忆类型无效。');
  integer(options.limit, 1, 20, '召回上限');
  integer(options.budgetChars, 256, 16000, '召回预算');
  integer(options.returnedChars, 2, options.budgetChars, '返回字符数');
  const scope = normalizeScope(options.scope);
  return { kind, method: options.method, memoryType: options.memoryType, limit: options.limit,
    budgetChars: options.budgetChars, returnedChars: options.returnedChars, ...(scope === undefined ? {} : { scope }) };
}

export function normalizeReadOptions(options) {
  return normalizeOptions(options);
}

export function buildReadDetails(memories, options) {
  const normalized = normalizeReadOptions(options);
  if (normalized.kind === 'show' && memories.length > 1) fail('单条核对最多返回一条记录。');
  if (normalized.kind === 'recall') {
    if (memories.length > normalized.limit) fail('实际返回条数超过召回上限。');
    if ((!memories.length && normalized.returnedChars !== 2) || (memories.length && normalized.returnedChars === 2)) fail('返回字符数与空结果不一致。');
  }
  const foundCategories = new Set(), foundFields = new Set();
  const records = memories.map(memory => {
    const fields = memoryRecallFields(memory);
    if (normalized.kind === 'recall') {
      if (normalized.memoryType !== 'all' && memoryTypeOf(memory) !== normalized.memoryType) fail('实际返回记录不符合记忆类型。');
      if (!recallScopeAllows(memory, fields, normalized.scope)) fail('实际返回记录不符合召回 scope。');
    }
    foundCategories.add(memory.category);
    fields.forEach(field => foundFields.add(field.key));
    return { id: memory.id, revision: memory.revision, verification: memory.confirmed === true ? 'confirmed' : 'reference' };
  });
  const confirmedCount = records.filter(record => record.verification === 'confirmed').length;
  const details = { ...normalized,
    categories: CATEGORIES.filter(category => foundCategories.has(category)),
    fields: fieldKeys.filter(key => foundFields.has(key)), records,
    confirmedCount, referenceCount: records.length - confirmedCount };
  validateReadDetails(details, memories.map(memory => memory.id));
  return details;
}

// Validate the historical snapshot as written. Current records may since have
// changed or been deleted; never reconstruct a past read from current content.
export function validateReadDetails(details, memoryIds) {
  const kind = details?.kind;
  const keys = kind === 'recall' ? recallKeys : contextKeys;
  exactObject(details, [...keys, ...derivedKeys], [...keys.filter(key => key !== 'scope'), ...derivedKeys], '读取审计详情');
  const options = Object.fromEntries(keys.filter(key => own(details, key)).map(key => [key, details[key]]));
  // A backup can contain an earlier retrieval implementation. The bounded
  // identifier is historical metadata, not proof of its source or truth.
  const normalized = normalizeOptions(options, { historical: true });
  list(memoryIds, undefined, 5000, '活动记忆编号');
  list(details.categories, CATEGORIES, CATEGORIES.length, '实际读取主题');
  list(details.fields, fieldKeys, fieldKeys.length, '实际读取字段');
  if (!Array.isArray(details.records) || details.records.length !== memoryIds.length || Reflect.ownKeys(details.records).length !== details.records.length + 1) fail('读取版本列表与活动记忆编号不一致。');
  let confirmed = 0;
  for (let index = 0; index < details.records.length; index++) {
    const record = details.records[index];
    exactObject(record, ['id', 'revision', 'verification'], ['id', 'revision', 'verification'], '读取版本');
    if (record.id !== memoryIds[index]) fail('读取版本的编号和顺序必须与活动一致。');
    integer(record.revision, 1, Number.MAX_SAFE_INTEGER, '读取版本号');
    if (!['confirmed', 'reference'].includes(record.verification)) fail('读取核实状态无效。');
    if (record.verification === 'confirmed') confirmed++;
  }
  integer(details.confirmedCount, 0, details.records.length, '确认数量');
  integer(details.referenceCount, 0, details.records.length, '参考数量');
  if (details.confirmedCount !== confirmed || details.referenceCount !== details.records.length - confirmed) fail('读取数量与版本列表不一致。');
  if (!details.records.length && (details.categories.length || details.fields.length)) fail('空读取不能包含实际主题或字段。');
  if (details.records.length && !details.categories.length) fail('非空读取必须有实际主题。');
  if (kind === 'show' && details.records.length > 1) fail('单条核对最多返回一条记录。');
  if (kind === 'recall') {
    if (details.records.length > normalized.limit) fail('读取版本列表超过召回上限。');
    if ((!details.records.length && normalized.returnedChars !== 2) || (details.records.length && normalized.returnedChars === 2)) fail('返回字符数与空结果不一致。');
    const fields = details.fields.map(key => ({ key }));
    if (details.records.length && details.categories.some(category => !recallScopeAllows({ category }, fields, normalized.scope))) fail('历史读取主题或字段与 scope 不一致。');
  }
}
