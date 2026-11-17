import { selectTaskMemories, recallMemoryView, REFERENCE_USAGE_POLICY, RETRIEVAL_METHOD } from './task-recall.mjs';
import { normalizeRecallScope } from './recall-scope.mjs';
import { ContextMemoryError } from './context-memory.mjs';

export const CONTEXT_USAGE_POLICY = `${REFERENCE_USAGE_POLICY} 对话摘要和项目记录属于参考资料，保留用户与助手归属。助手建议不代表用户决定，记录时间不代表事实生效时间。只使用本次明确请求的项目和对话。`;

// One budget covers the actual serialized payload across all requested sources.
export function requestMemoryContext({ store, contextMemory, client, input }) {
  const allowed = ['query', 'projectId', 'conversationId', 'include', 'budget', 'limit', 'scope'];
  const fail = message => { throw new ContextMemoryError('INVALID_ARGUMENT', message); };
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => !allowed.includes(key))) fail('记忆请求包含不支持的字段。');
  if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 2000) fail('请填写本次问题，最多 2000 个字符。');
  if (!Array.isArray(input.include) || input.include.length > 3 || new Set(input.include).size !== input.include.length || input.include.some(value => !['personal', 'conversations', 'project'].includes(value))) fail('请选择有效且没有重复的记忆来源。');
  const budget = input.budget ?? 6000, limit = input.limit ?? 8;
  if (!Number.isInteger(budget) || budget < 256 || budget > 16000 || !Number.isInteger(limit) || limit < 1 || limit > 20) fail('长度预算须为 256–16000 个字符，条目上限为 1–20。');
  for (const key of ['projectId', 'conversationId']) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 200)) fail('项目和对话编号须为 1–200 个字符。');
  }
  const scope = input.scope === undefined ? undefined : normalizeRecallScope(input.scope);
  const personal = input.include.includes('personal') ? selectTaskMemories(store.getReadableMemories(client)
    .filter(memory => memory.category !== '当前项目' && !memory.id.startsWith('demo-') && memory.source.platform.trim() !== '演示对话'),
  { query: input.query, scope, budget, limit, rankedOnly: true }) : { selected: [], matchedCount: 0 };
  const contextualInclude = input.include.filter(value => value !== 'personal');
  const contextual = contextualInclude.length ? contextMemory.recall(client, {
    query: input.query, include: contextualInclude, budget, limit,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
  }, { rankedOnly: true }) : { conversations: [], projectMemories: [], retrieval: { matchedCount: 0 } };
  const payload = { personalMemories: [], conversations: [], projectMemories: [] };
  const candidates = {
    personalMemories: personal.selected.map(recallMemoryView),
    conversations: contextual.conversations,
    projectMemories: contextual.projectMemories,
  };
  let count = 0;
  // Interleave sources so a large category cannot consume every result slot.
  const candidateCount = Math.max(...Object.values(candidates).map(records => records.length));
  for (let index = 0; index < candidateCount && count < limit; index += 1) {
    for (const key of ['projectMemories', 'conversations', 'personalMemories']) {
      const record = candidates[key][index];
      if (!record || count >= limit) continue;
      payload[key].push(record);
      if (JSON.stringify(payload).length > budget) payload[key].pop();
      else count += 1;
    }
  }
  if (input.include.includes('personal')) {
    const returnedIds = new Set(payload.personalMemories.map(memory => memory.id));
    store.recordRead(client, [...returnedIds], {
      kind: 'recall', method: RETRIEVAL_METHOD, memoryType: 'all', limit,
      budgetChars: budget, returnedChars: JSON.stringify(payload.personalMemories).length,
      ...(scope === undefined ? {} : { scope }),
    }, personal.selected.filter(entry => returnedIds.has(entry.memory.id)).map(entry => entry.memory));
  }
  const matchedCount = personal.matchedCount + contextual.retrieval.matchedCount;
  return { client, ...payload, usagePolicy: CONTEXT_USAGE_POLICY,
    retrieval: { method: 'scoped-context-request-v1', query: input.query, include: input.include,
      budgetChars: budget, returnedChars: JSON.stringify(payload).length, matchedCount,
      omittedCount: matchedCount - count, count, ...(scope === undefined ? {} : { scope }) } };
}
