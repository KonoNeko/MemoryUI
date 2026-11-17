import { PROFILE_FIELDS } from './profile-model.js';
import { CATEGORIES } from './memory-taxonomy.mjs';

const fieldKeys = [...PROFILE_FIELDS.map(field => field.key), 'communication'];
const scopeKeys = ['includeFields', 'excludeFields', 'includeCategories', 'excludeCategories'];
const allowed = { includeFields: fieldKeys, excludeFields: fieldKeys, includeCategories: CATEGORIES, excludeCategories: CATEGORIES };

export class RecallScopeError extends Error {
  constructor(message = '记忆检索范围无效。') {
    super(message);
    this.name = 'RecallScopeError';
    this.code = 'INVALID_RECALL_SCOPE';
  }
}

export const RECALL_SCOPE_POLICY = 'scope 在客户端已获授权且可用的候选中进一步筛选，不扩大权限。includeFields 省略时不限制字段；显式空数组不召回任何记录。字段包含要求整条记录至少有一个已识别字段，且所有已识别字段均在包含列表中；任一排除字段命中即跳过整条。includeCategories 同样省略不限制、空数组不召回；主题包含/排除与字段条件同时满足。一般返回完整原文，不截取字段、不改写否定；唯一可用且获授权的完整出生日期可生成单独标明日期的年龄视图，只返回年龄，不带出生日期正文，沿用来源编号、版本和核实级别。显式排除birthday时也不使用生日派生年龄。字段索引不是任意自由文本的敏感信息脱敏保证，未标注的细节可能仍在原文中。';

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const listSchema = (values, description) => ({ type: 'array', minItems: 0, maxItems: values.length, uniqueItems: true,
  items: { type: 'string', enum: [...values] }, description });

export const RECALL_SCOPE_SCHEMA = freeze({
  type: 'object', minProperties: 1, maxProperties: scopeKeys.length, additionalProperties: false,
  description: '可选结构化检索范围；同一维度包含与排除不得重叠。显式 include=[] 返回空结果，省略则不作该维度限制；基于字段索引筛选完整记录，不是文本脱敏。',
  properties: {
    includeFields: listSchema(fieldKeys, '全部已识别字段都必须在此列表，且记录至少有一个字段。省略不限制；空数组不召回任何记录。'),
    excludeFields: listSchema(fieldKeys, '任一已识别字段命中即跳过整条；空数组不增加排除。'),
    includeCategories: listSchema(CATEGORIES, '仅这些真实记忆主题；省略不限制，空数组不召回任何记录。'),
    excludeCategories: listSchema(CATEGORIES, '排除这些主题；与字段范围同时生效。'),
  },
});

export function normalizeRecallScope(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new RecallScopeError('scope 必须是普通对象，不能为 null、数组或字符串。');
  }
  const keys = Reflect.ownKeys(value);
  if (!keys.length || keys.some(key => !scopeKeys.includes(key))) throw new RecallScopeError('scope 至少包含一个支持的范围键，且不能包含额外键。');
  const result = {};
  for (const key of scopeKeys) {
    if (!Object.hasOwn(value, key)) continue;
    const list = value[key];
    if (!Array.isArray(list) || list.length > allowed[key].length) throw new RecallScopeError(`${key} 必须是有长度上限的枚举数组。`);
    const entries = Reflect.ownKeys(list).filter(key => key !== 'length');
    if (entries.length !== list.length || entries.some(key => typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= list.length)) {
      throw new RecallScopeError(`${key} 必须是连续数组，不能有额外属性。`);
    }
    const values = [];
    for (let index = 0; index < list.length; index++) {
      const item = list[index];
      if (typeof item !== 'string' || !allowed[key].includes(item) || values.includes(item)) throw new RecallScopeError(`${key} 包含未知或重复的枚举值。`);
      values.push(item);
    }
    result[key] = values;
  }
  for (const [include, exclude] of [['includeFields', 'excludeFields'], ['includeCategories', 'excludeCategories']]) {
    if (result[include]?.some(item => result[exclude]?.includes(item))) throw new RecallScopeError(`${include} 与 ${exclude} 不能重叠。`);
  }
  return result;
}

// Caller must still prefilter authorization, status, expiry and demo records.
export function recallScopeAllows(memory, fields, scope) {
  if (scope === undefined) return true;
  if (scope.includeFields !== undefined && (!fields.length || fields.some(field => !scope.includeFields.includes(field.key)))) return false;
  if (scope.excludeFields?.some(key => fields.some(field => field.key === key))) return false;
  if (scope.includeCategories !== undefined && !scope.includeCategories.includes(memory.category)) return false;
  if (scope.excludeCategories?.includes(memory.category)) return false;
  return true;
}
