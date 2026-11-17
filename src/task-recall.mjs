import { memoryTypeOf } from './memory-types.js';
import { memoryReview, REVIEW_REASONS } from './memory-policy.js';
import { memoryEvidenceRef } from './memory-evidence.mjs';
import { parseRecallIntent, structuredRecallIntent, memoryRecallFields, memoryMeasurementEvidence, memorySubjectMatch, taskScopeAllows, memoryTemporalEvidence, temporalRecallFit, temporalRecallReason } from './recall-intent.mjs';
import { normalizeRecallScope, recallScopeAllows, RECALL_SCOPE_POLICY } from './recall-scope.mjs';
import { measurementConcepts, measurementLabels, incompatibleMeasurements } from './measurement-concepts.mjs';
import { projectProfileAgeForRecall, profileAgeProjection } from './profile-age.js';

export const REFERENCE_USAGE_POLICY = '已确认记忆优先；verification=reference 的内容仅作参考，使用时保留不确定性，不可当作已确认事实。参考内容与已确认记忆冲突时，不得覆盖已确认信息；需要时说明分歧并请用户修正。测量概念匹配只表示内容相关，不证明已有实测值；鞋码、脚长、鞋垫长和衣服尺码不可互代或自动换算。reviewReasons 是提示核对的理由，不是概率或置信度。evidenceRef 定位当前内容的记录版本，不含源摘录或旧内容；recordedAt 是系统记录时间，不是事实生效时间。原始依据由所有者在面板查看，不因此扩大客户端读取授权。';
export const RETRIEVAL_METHOD = 'local-field-lexical-v5';

export function memoryContextView(memory, { readableIds } = {}) {
  const { id, content, category, workspace, revision, updatedAt, validUntil, status, confirmed, supersedes } = memory;
  const review = memoryReview(memory);
  const ageProjection = profileAgeProjection(memory);
  return { id, content, category, workspace, revision, updatedAt, validUntil, status, confirmed,
    memoryType: memoryTypeOf(memory), ...review, referenceOnly: review.verification === 'reference', evidenceRef: memoryEvidenceRef(ageProjection?.sourceMemory ?? memory),
    ...(ageProjection ? { derived: { kind: 'age_from_birthday', asOfDate: ageProjection.asOfDate, sourceField: 'birthday' } } : {}),
    reviewReasonLabels: review.reviewReasons.map(reason => REVIEW_REASONS[reason]),
    ...(typeof supersedes === 'string' && readableIds?.has(supersedes) ? { supersedes } : {}) };
}

const stopwords = new Set(['的', '了', '和', '是', '我', '你', '我的', '你的', '他的', '她的', '我们的', '请', '帮我', '给我', '一下', '关于', '需要', '这个', '进行', '哪些', '什么', '告诉', '知道', '记得', '现在', '目前', '当前', '以前', '过去', '曾经', '之前', '有', '在', '给', '应该', '怎么', '如何', '一个', '个', '条', '项', '次', '些', '这', '那', '多少', '今年', '吗', '呢', 'how', 'the', 'a', 'an', 'and', 'to', 'for', 'my', 'me', 'is', 'i', 'am', 'do', 'does', 'what', 'are', 'now', 'currently', 'previously']);
for (const word of ['记录', '已经', '数据', '资料', '找出', '列出', '查询', '读取', '包括', '显示', '返回', '保留', '所有', '全部', '不要', '不必', '无需', '不用', '不需要', '相关', '分别', '先', '再', '本次', '这次', 'please', 'include']) stopwords.add(word);
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const normalize = text => String(text).normalize('NFKC').toLocaleLowerCase();
export function recallTerms(text) {
  return [...new Set([...measurementLabels(text), ...[...segmenter.segment(normalize(text))]
    .filter(part => part.isWordLike).map(part => part.segment)
    .filter(term => !stopwords.has(term))])];
}

export function recallMemoryView({ memory, matchedTerms, matchedFields, temporal, reason, readableIds }) {
  return { ...memoryContextView(memory, { readableIds }), matchedTerms, retrievalReason: reason,
    ...(matchedFields?.length ? { matchedFields } : {}),
    ...(temporal && (temporal.requested !== 'unspecified' || temporal.scope !== 'unspecified') ? { temporalEvidence: temporal } : {}) };
}

// Local lexical retrieval plus a limited, inspectable personal-field vocabulary.
// This does not use semantic embeddings, an LLM reranker or inferred fact dates.
// Caller supplies only memories already eligible for this client and time.
export function selectTaskMemories(memories, { query, limit = 8, budget = 6000, memoryType = 'all', scope: rawScope, now = new Date(), timeZone, rankedOnly = false }) {
  const scope = normalizeRecallScope(rawScope);
  const intent = structuredRecallIntent(parseRecallIntent(query), scope);
  const otherAgeDate = intent.temporal === 'historical' || intent.temporal === 'comparison'
    || /\b\d{4}\b|去年|前年|明年|后年|昨天|明天|上个月|下个月|未来|\b(?:last|next) year\b/i.test(intent.lexicalQuery);
  const viewMemories = projectProfileAgeForRecall(memories, {
    enabled: !otherAgeDate && intent.fields.some(field => field.key === 'age') && !intent.fields.some(field => field.key === 'birthday'),
    excludeBirthday: scope?.excludeFields?.includes('birthday') || intent.explicitExcludedFields.includes('birthday'), now, timeZone,
  });
  const terms = recallTerms(intent.lexicalQuery);
  const requestedDates = [...new Set(intent.lexicalQuery.match(/\b\d{4}(?:-\d{2}(?:-\d{2})?)?\b/g) || [])];
  const fieldOnlyTerms = new Set(intent.fields.flatMap(field => [...recallTerms(field.label), ...recallTerms(field.queryAlias)]));
  const requestedMeasurements = [...measurementConcepts(intent.lexicalQuery), ...intent.fields
    .filter(field => ['height', 'weight', 'shoeSize'].includes(field.key))];
  const measurementOnlyTerms = new Set([...requestedMeasurements.flatMap(concept => [
    ...recallTerms(concept.label), ...recallTerms(concept.queryAlias || ''),
  ]), ...recallTerms('长度 尺寸 尺码 长 多长 厘米 毫米 公斤 多少 实际 实测 本身 测量 cm mm kg centimeters centimetres measured length size')]);
  const candidates = viewMemories.filter(memory => memoryType === 'all' || memoryTypeOf(memory) === memoryType);
  const documents = candidates.map(memory => { const text = `${memory.content}\n${memory.category}`; return { memory, text: normalize(text), words: recallTerms(text), fields: memoryRecallFields(memory) }; })
    .filter(doc => scope === undefined || recallScopeAllows(doc.memory, doc.fields, scope) && taskScopeAllows(doc.memory, doc.fields, intent)
      && !doc.fields.some(field => intent.excludedFields.includes(field.key)));
  const readableIds = new Set((scope === undefined ? memories : documents.map(doc => doc.memory)).map(memory => memory.id));
  const averageLength = documents.reduce((sum, doc) => sum + doc.words.length, 0) / Math.max(1, documents.length);
  const frequency = new Map(terms.map(term => [term, documents.filter(doc => doc.words.includes(term)).length]));
  const ranked = documents.flatMap(doc => {
    if (scope === undefined && (!taskScopeAllows(doc.memory, doc.fields, intent) || doc.fields.some(field => intent.excludedFields.includes(field.key)))) return [];
    const subjects = memorySubjectMatch(doc.memory, intent);
    const lexicalTerms = terms.filter(term => doc.words.includes(term));
    const matchedFields = intent.fields.filter(field => doc.fields.some(candidate => candidate.key === field.key)).map(({ key, label }) => ({ key, label }));
    // This guard applies to measurement-only evidence, not another requested
    // domain which happens to mention a coat, shoe or measurement word.
    const measurementTopics = measurementConcepts(doc.memory.content);
    const measurementEvidence = memoryMeasurementEvidence(doc.memory);
    if ((incompatibleMeasurements(measurementEvidence, requestedMeasurements)
      || requestedMeasurements.length && measurementTopics.length && !measurementEvidence.length)
      && !matchedFields.some(field => !['height', 'weight', 'shoeSize'].includes(field.key))
      && !lexicalTerms.some(term => !measurementOnlyTerms.has(term))) return [];
    const directFieldMatches = matchedFields.filter(field => doc.fields.some(candidate => candidate.key === field.key && !candidate.derivedFromEpisode)).length;
    // A lone attribute word in "朋友的身高…" or in a design note cannot
    // establish the owner's attribute. Other task terms ("职业 AI 开发") may
    // still find useful non-profile procedures through normal lexical retrieval.
    if (intent.fields.length && !matchedFields.length && !subjects.length && !lexicalTerms.some(term => !fieldOnlyTerms.has(term))) return [];
    const matchedTerms = [...new Set([...lexicalTerms, ...matchedFields.map(field => field.label), ...subjects.map(subject => subject.label)])];
    const exact = normalize(intent.lexicalQuery).trim();
    const phrase = exact.length > 1 && doc.text.includes(exact);
    if (!matchedTerms.length && !phrase) return [];
    const score = lexicalTerms.reduce((sum, term) => {
      const rarity = Math.log(1 + (documents.length - frequency.get(term) + 0.5) / (frequency.get(term) + 0.5));
      return sum + rarity / (0.25 + 0.75 * doc.words.length / Math.max(1, averageLength));
    }, 0) + (phrase ? 2 : 0);
    const temporal = memoryTemporalEvidence(doc.memory, intent.temporal);
    const dateMatches = requestedDates.filter(date => new RegExp(`(?<!\\d)${date}(?!\\d)`).test(doc.text)).length;
    const reasons = [matchedFields.length ? intent.structuredFields ? `匹配指定字段范围：${matchedFields.map(field => field.label).join('、')}（结构化 scope 与原文字段对应）` : `匹配个人字段：${matchedFields.map(field => field.label).join('、')}（查询同义表达与原文字段对应）` : subjects.length ? `匹配关系对象：${subjects.map(subject => subject.label).join('、')}；匹配关键词：${matchedTerms.join('、')}` : phrase ? '匹配完整查询' : `匹配关键词：${matchedTerms.join('、')}`, temporalRecallReason(temporal)].filter(Boolean);
    const conflictedReference = memoryReview(doc.memory).reviewReasons.includes('conflict');
    return [{ memory: doc.memory, matchedTerms, matchedFields, directFieldMatches, temporal, dateMatches, conflictedReference, score: score + subjects.length * 2, reason: reasons.join('；'), readableIds }];
  }).sort((a, b) => b.matchedFields.length - a.matchedFields.length
    || Number(a.conflictedReference) - Number(b.conflictedReference)
    || b.dateMatches - a.dateMatches
    || temporalRecallFit(b.temporal) - temporalRecallFit(a.temporal)
    || b.directFieldMatches - a.directFieldMatches
    || Number(b.memory.confirmed === true) - Number(a.memory.confirmed === true)
    || b.score - a.score
    || String(b.memory.updatedAt || '').localeCompare(String(a.memory.updatedAt || ''))
    || a.memory.id.localeCompare(b.memory.id));
  // The combined context selector owns its final envelope and global budget.
  if (rankedOnly) return { selected: ranked, matchedCount: ranked.length, terms };
  const selected = [];
  let usedChars = 2;
  for (const entry of ranked) {
    if (selected.length >= limit) break;
    // Include an entire record, including its identifier and version. A partial
    // sentence can drop a negation, qualification or time condition.
    const cost = JSON.stringify(recallMemoryView(entry)).length + (selected.length ? 1 : 0);
    if (usedChars + cost > budget) continue;
    usedChars += cost;
    selected.push(entry);
  }
  return { selected, matchedCount: ranked.length, usedChars, omittedCount: ranked.length - selected.length, terms,
    ...(scope === undefined ? {} : { scope, scopePolicy: RECALL_SCOPE_POLICY }) };
}
