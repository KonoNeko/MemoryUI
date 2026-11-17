import { PROFILE_FIELDS, parseProfileItem } from './profile-model.js';
import { measurementConcepts, ownerMeasurementRequest, measurementFieldObject } from './measurement-concepts.mjs';

const normalize = value => String(value).normalize('NFKC').toLocaleLowerCase();
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Deliberately small, reviewable domain vocabulary. These patterns only name a
// field; they neither infer its value nor infer a personal trait from prose.
const aliases = {
  age: /年龄|年纪|几岁|多大(?:年纪|年龄)|\bage\b/,
  height: /身高|个子|个头|(?:我|本人|用户)(?:现在|目前|大概)?(?:有)?多高|^(?:现在|目前)?(?:有)?多高[?？。!！\s]*$|\bheight\b|\bhow tall am i\b/,
  weight: /体重|(?:我|本人|用户)(?:现在|目前|大概)?(?:有)?多重(?=[?？。!！啊呀呢\s]|$)|^(?:现在|目前)?(?:有)?多重[?？。!！\s]*$|(?:我|本人)(?:的)?分量|分量(?=各是|是多少)|多少斤|几斤|\bweight\b|\bweigh\b/,
  shoeSize: /鞋码|鞋号|(?:穿|我)(?:几|多少)码|穿(?:多大|多大的|什么)(?:的)?码|鞋.{0,10}(?:几号|几码|多大码)|^几码[?？。!！\s]*$|\bshoe sizes?\b|\bsize (?:of )?(?:my )?shoes?\b/,
  occupation: /职业|主业|做什么工作|从事什么|第一份工作|行当|(?:我|本人).{0,8}靠(?:啥|什么)工作|\boccupation\b|\bprofession\b|\bwhat (?:is my |is the |do i do for a )?job\b/,
  sidework: /副业|\bside (?:job|business|project)\b/,
  hobbies: /爱好|兴趣爱好|有什么兴趣|\bhobb(?:y|ies)\b/,
  gender: /性别|\bgender\b/,
  birthday: /出生日期|出生年月|生日|\bbirth(?:day| date)\b|\bdate of birth\b/,
  location: /居住地|常住地|住(?:在)?哪里|住在哪|住哪个城市|\bwhere do i live\b/,
  languages: /使用什么语言|会说什么语言|会哪些语言|(?:哪几|哪些|什么|几种)(?:种)?语言|\blanguages? do i speak\b/,
  skills: /技能|擅长|\bskills?\b/,
  goal: /当前目标|近期目标|现阶段目标|\bcurrent goals?\b/,
  mbti: /\bmbti\b/,
  attachment: /依恋模式|依恋类型|\battachment style\b/,
};
const acceptedPrefixes = {
  age: ['年纪', 'age'], height: ['height'], weight: ['weight'], shoeSize: ['鞋号', 'shoe size'],
  occupation: ['主业', 'occupation', 'profession'], gender: ['gender'], birthday: ['生日', 'birthday', 'birth date'],
  hobbies: ['hobby', 'hobbies'], sidework: ['side job', 'side business'], skills: ['skills'],
};
const extraFields = [{ key: 'communication', label: '沟通偏好' }];
const fieldDefinitions = [...PROFILE_FIELDS, ...extraFields].map(field => ({
  key: field.key,
  label: field.label,
  queryPattern: aliases[field.key] || new RegExp(escapePattern(normalize(field.label))),
  prefix: new RegExp(`(?:^|[\\n；;。.])\\s*(?:${[field.label, ...(acceptedPrefixes[field.key] || [])].map(label => escapePattern(normalize(label))).join('|')})\\s*[:：]`),
  selfStatement: new RegExp(`(?:我|本人|用户)(?:的)?${escapePattern(normalize(field.label))}`),
}));

function fieldQueryMatch(field, text) {
  // Bare “穿什么码” keeps its existing shoe default, but an explicitly named
  // garment/length prevents that default from becoming a second shoe request.
  if (field.key === 'shoeSize' && !/鞋|\bshoes?\b/.test(text)
    && measurementConcepts(text).some(concept => ['clothingSize', 'footLength', 'insoleLength'].includes(concept.key))) return null;
  return field.queryPattern.exec(text);
}

const currentCue = /(?:现在|目前|当前|现阶段|如今|最新|最近一次)|\b(?:current|currently|now|latest)\b/;
const pastCue = /(?:以前|之前|过去|曾经|原先|当年|历史|原来|回顾|结业|第一份工作)|\b(?:previous|previously|formerly|past|used to)\b/;
const fieldLabels = fieldDefinitions.map(field => escapePattern(normalize(field.label))).join('|');
const pastFact = new RegExp(`(?:以前|曾经|原先|过去)(?:的)?(?:${fieldLabels}|主业|从事|是|做|担任)|(?:${fieldLabels}|主业)\\s*[:：]\\s*(?:以前|曾经|原先|过去)|\\b(?:previously|formerly|used to)\\b`);
const currentFact = new RegExp(`(?:现在|目前|如今)(?:的)?(?:${fieldLabels}|主业|从事|是|做|担任)|(?:${fieldLabels}|主业)\\s*[:：]\\s*(?:现在|目前|如今)|(?:^|\\n)\\s*当前目标\\s*[:：]|\\b(?:currently|current (?:job|occupation|goal))\\b`);

function careerEpisode(text) {
  const line = text.split('\n').find(value => /^\s*(?:人生经历|工作经历|职业经历|履历)\s*[:：]/.test(value));
  if (!line || /(?:计划|打算|希望|将来|未来|准备|拟于)/.test(line)) return null;
  const work = /(?:担任|任职|从事|转行|入职|就职|转入.{0,20}(?:研究|开发|设计|工程))/;
  if (!work.test(line)) return null;
  const body = line.replace(/^\s*(?:人生经历|工作经历|职业经历|履历)\s*[:：]\s*/, '');
  // Only an explicit clause subject establishes third-party attribution. A
  // relation in an employer name or "在姐姐鼓励下，我…" is not that subject.
  // Reuse the same finite relation vocabulary as query matching; this does not
  // resolve arbitrary pronouns, quotations or implicit subjects in free prose.
  const subject = clause => {
    const prefix = clause.slice(0, work.exec(clause)?.index ?? clause.length);
    for (const fragment of prefix.split(/[,，]/).reverse()) {
      const leading = fragment.trim().replace(/^(?:(?:从|自|于|在|以前|曾经|过去|现在|目前|如今)\s*|\d{4}(?:[-–—~至到]\d{4})?(?:-\d{2}(?:-\d{2})?)?年?(?:起|以来)?\s*)+/, '');
      const related = /^第三人/.test(leading) || relationDefinitions.some(relation => {
        const match = relation.pattern.exec(leading);
        return match && /^(?:(?:我的?|本人的?|用户的?|my|the)\s*)?$/.test(leading.slice(0, match.index));
      });
      if (related) return 'third-party';
      if (/^(?:我|本人|用户)(?!的)|^i\b/.test(leading)) return 'owner';
    }
    return 'unspecified';
  };
  const segments = [];
  for (const clause of body.split(/[；;。]/)) {
    let segment = '';
    for (const part of clause.split(/[,，]/)) {
      // A new stated employment subject starts its own evidence segment.
      // Comma qualifications such as "持续至今" stay with their employment.
      if (work.test(segment) && work.test(part) && subject(part) !== 'unspecified') {
        segments.push(segment); segment = part;
      } else segment += `${segment ? ',' : ''}${part}`;
    }
    if (segment) segments.push(segment);
  }
  let inherited = 'unspecified';
  const clauses = segments.filter(clause => work.test(clause)).filter(clause => {
    const stated = subject(clause);
    if (stated !== 'unspecified') inherited = stated;
    return inherited !== 'third-party';
  });
  // The record explicitly calls this a life/work experience. Keep the whole
  // source record: the index association does not extract a new current job or
  // derive employment dates from the date when the memory was edited.
  const ongoing = clause => /(?:至今|迄今|仍在|仍然)/.test(clause);
  const closedRange = /\d{4}\s*年?\s*(?:[-–—~]|至|到)\s*\d{4}\s*年?/;
  return { excerpt: line.trim(), ownerApplicable: clauses.length > 0, applicableText: clauses.join('；'),
    historical: clauses.some(clause => closedRange.test(clause) && !ongoing(clause)),
    current: clauses.some(ongoing) };
}

// Relation aliases identify a stated subject, not the owner's inferred family.
// Names are only compared when they appear immediately after a relation label.
const relationDefinitions = [
  { key: 'friend', label: '朋友', pattern: /朋友|\bfriend(?:'s)?\b/ },
  { key: 'colleague', label: '同事', pattern: /同事|\bcolleague(?:'s)?\b/ },
  { key: 'sister', label: '姐妹', pattern: /姐姐|妹妹|\bsister(?:'s)?\b/ },
  { key: 'brother', label: '兄弟', pattern: /哥哥|弟弟|\bbrother(?:'s)?\b/ },
  { key: 'mother', label: '母亲', pattern: /母亲|妈妈|\bmother(?:'s)?\b/ },
  { key: 'father', label: '父亲', pattern: /父亲|爸爸|\bfather(?:'s)?\b/ },
  { key: 'child', label: '子女', pattern: /孩子|女儿|儿子|\b(?:child|daughter|son)(?:'s)?\b/ },
  { key: 'partner', label: '伴侣', pattern: /伴侣|\bpartner(?:'s)?\b/ },
  { key: 'customer', label: '客户', pattern: /客户|\bcustomer(?:'s)?\b/ },
  { key: 'pet', label: '宠物', pattern: /宠物|猫|狗|\b(?:pet|cat|dog)(?:'s)?\b/ },
];
const relationSubjects = text => relationDefinitions.filter(relation => relation.pattern.test(text));
const ownerScope = text => /(?:我|本人|用户)(?:的|自己|本人)?(?:现在|目前|平时|平常|有)?(?:身高|体重|鞋码|年龄|职业|主业|性别|生日|出生日期|个子|分量|住|穿|多高|多重|做)|\bmy (?:own )?(?:height|weight|shoe size|age|gender|occupation|profession|job|birthday)\b/.test(text);
const subjectName = text => /(?:朋友|同事|姐姐|妹妹|哥哥|弟弟|客户)(?!的|身高|体重|职业|做|叫|是|有|在|喜欢|多|几|哪)([\p{Script=Han}]{1,4}?)(?=选|的|身高|体重|说|职业|，|,)/u.exec(text)?.[1] || null;

function queryFieldScope(text, inheritedSubjects = []) {
  const namedFields = fieldDefinitions.filter(field => fieldQueryMatch(field, text));
  // A component's height or a shoe-size selector is a design topic, not evidence
  // that the task needs the owner's body measurements. Explicit personal scope
  // ("根据我的鞋码设计…") still permits using the relevant personal record.
  const technicalObjects = '(?:项目|字体|页面|界面|组件|图标|算法|版式|布局|渲染|课程|输入框|选择器|卡片|变量|参数|节点|容器|元素|字段|代码|按钮|选项)';
  const designTopic = new RegExp(`${technicalObjects}|\\b(?:css|html|api|variable|component|input|selector)\\b`).test(text)
    || /鞋码.{0,3}设计|(?:设计|开发|实现|制作).*鞋码/.test(text);
  const personalScope = new RegExp(`(?:我的|本人的|用户的)(?:${fieldLabels})|(?:我|本人|用户)(?:现在|目前|大概)?(?:有)?多(?:高|重)|我穿(?:几|多少)码`).test(text)
    || /\b(?:my (?:height|weight|shoe size|age|gender|occupation)|how tall am i|how much do i weigh)\b/.test(text);
  const fieldIsTechnicalObject = new RegExp(`(?:${fieldLabels}|\\b(?:height|weight|shoe size|gender)\\b)\\s*(?:${technicalObjects}|variable|component|input|selector)`).test(text);
  const subjects = relationSubjects(text);
  const thirdPartyScope = subjects.length > 0 || inheritedSubjects.length > 0 && !ownerScope(text)
    || /(?:宠物|猫|狗|朋友|同事|伴侣|孩子|女儿|儿子|父亲|母亲|爸爸|妈妈|哥哥|姐姐|弟弟|妹妹|客户|第三人)(?:现在|目前|今年|已经|有|是)?(?:的|叫|穿|身高|体重|年龄|职业|性别|姓名|名字|称呼|几岁|多大|多高|多重|几码)/.test(text)
    || /(?:他|她|它)的/.test(text)
    || /\b(?:pet|friend|colleague|partner|child|daughter|son|mother|father|customer)(?:'s|\s+(?:name|height|weight|age|job))\b/.test(text);
  const excludedFields = (designTopic && (!personalScope || fieldIsTechnicalObject)) || thirdPartyScope ? namedFields : [];
  const fields = excludedFields.length ? [] : namedFields;
  return { fields: fields.map(field => ({ key: field.key, label: field.label, queryAlias: fieldQueryMatch(field, text)?.[0] || field.label })), excludedFields: excludedFields.map(field => field.key) };
}

function taskClauses(text) {
  // Keep coordination as syntax: "不要年龄以及我的身高" is one exclusion
  // list, while "不要年龄但读取身高" explicitly changes the instruction.
  const boundary = /[，,；;。！？!?]|\.(?=\s|$)|但是|不过|然而|但|\b(?:but|however)\b|(?=(?:不要|别|不必|不用|无需|不需要)(?:再)?(?:查询|查|读取|读|获取|使用|展示|返回|包含|带入))|(?=(?:只|仅)(?:需要|读取|查询|展示|返回|看|读|要))|、(?=(?:我|本人|用户|他|她|它|朋友|同事|姐姐|妹妹|女儿|儿子))|以及|还有|并且|(?:和|与)(?=(?:我的|本人的|用户的|他|她|它|宠物|猫|狗|朋友|同事|伴侣|孩子|女儿|儿子|父亲|母亲|爸爸|妈妈|哥哥|姐姐|弟弟|妹妹|客户|第三人|组件|页面|卡片|变量|字段))|\s+and\s+/g;
  const result = [];
  let start = 0;
  let coordinated = false;
  for (const match of text.matchAll(boundary)) {
    if (match.index > start) result.push({ text: text.slice(start, match.index).trim(), coordinated });
    coordinated = /^(?:以及|还有|并且|和|与|、|\s+and\s+)$/.test(match[0]);
    start = match.index + match[0].length;
  }
  if (start < text.length) result.push({ text: text.slice(start).trim(), coordinated });
  return result.filter(clause => clause.text);
}

function fieldListFragment(text) {
  let remainder = text;
  let matched = false;
  if (/身体(?:数值|测量|数据)/.test(remainder)) {
    matched = true;
    remainder = remainder.replace(/身体(?:数值|测量|数据)/g, ' ');
  }
  for (const concept of measurementConcepts(remainder)) {
    matched = true;
    remainder = remainder.replace(concept.queryAlias, ' ');
  }
  for (const field of fieldDefinitions) {
    const expression = fieldQueryMatch(field, remainder)?.[0];
    if (!expression) continue;
    matched = true;
    remainder = remainder.replace(expression, ' ');
  }
  remainder = remainder.replace(/(?:我的|本人的|用户的|我|本人|用户|的|数据|数值|资料|信息|和|与|以及|还有|并且)|\b(?:my|own|the|and|or|data|information)\b|[\s、:：]+/g, '');
  return matched && remainder.length === 0;
}

export function parseRecallIntent(query) {
  const text = normalize(query);
  // Resolve explicit subject changes per clause: a child's unknown age must not
  // cancel "我的身高" elsewhere in the same question. We do not resolve hidden
  // pronoun antecedents or guess missing subjects across complex clauses.
  const clauses = taskClauses(text);
  const explicitExcluded = new Set();
  const excludedMeasurementScopes = [];
  const excludedTopics = [];
  const positiveClauses = [];
  const onlyFields = new Set();
  const scopes = [];
  let inheritedSubjects = [];
  let excludedList = false;
  let excludedMeasurementContext = null;
  for (const segment of clauses) {
    const clause = segment.text;
    const instruction = clause.replace(/^(?:(?:请|先|这次|本次|麻烦|记得|务必|也|还|同时|然后)\s*)+/, '');
    const conversion = /^(?:(?:不要|别)(?:拿|用|使用|把|将)|(?:do not|don't)\s+use\b)/.test(instruction)
      ? /推算|换算|猜测|估算|当成|当作|代替|\bto (?:infer|derive|estimate|convert|guess)\b/.exec(clause) : null;
    // Only explicit retrieval/display exclusions are removed. A content rule
    // such as "不要吞掉异常" or "不喝咖啡因" remains searchable in full.
    const exclusion = /^(?:(?:不要|别|不必|不用|无需|不需要)(?:再)?(?:(?:查询|查|读取|读|获取|使用|展示|返回|包含|带入)|(?:把|将).*(?:带进|带入|放进|放入)|(?:任何)?.*(?:样本|数值本身))|(?:忽略|排除)|(?:我|本人|用户)?(?:不是|并非)(?:在)?(?:问|询问|查询|读取)|(?:do not|don't|without)\s+(?:read|include|retrieve|use|show)\b|(?:ignore|exclude|omit)\s+|leave\s+.+\s+out\b)/.test(instruction)
      || /^(?:不要|别|不必|不用|无需|不需要)/.test(instruction) && fieldListFragment(instruction.replace(/^(?:不要|别|不必|不用|无需|不需要)/, ''))
      || Boolean(conversion)
      || excludedList && segment.coordinated && fieldListFragment(clause);
    if (exclusion) {
      excludedList = true;
      // In “do not use shoe size to infer foot length”, only the source is
      // prohibited. A later request for actual foot evidence stays affirmative.
      const excludedText = conversion ? clause.slice(0, conversion.index) : clause;
      for (const field of fieldDefinitions.filter(field => fieldQueryMatch(field, excludedText))) explicitExcluded.add(field.key);
      // Keep who/what an extra measurement exclusion describes. Excluding a
      // friend's foot or a component field must not exclude the owner's foot.
      const related = relationSubjects(excludedText).map(({ key, label }) => ({ key, label }));
      const ownMeasurement = ownerMeasurementRequest(excludedText);
      const context = related.length ? { subjects: related, ownerOnly: false, technicalOnly: false }
        : ownMeasurement && !measurementFieldObject(excludedText) ? { subjects: [], ownerOnly: true, technicalOnly: false }
          : segment.coordinated && excludedMeasurementContext ? excludedMeasurementContext
            : { subjects: [], ownerOnly: false, technicalOnly: /组件|变量|字段|输入框|\b(?:component|variable|input|field)\b/.test(excludedText) };
      excludedMeasurementContext = context;
      const keys = measurementConcepts(excludedText).map(concept => concept.key).filter(key => ['footLength', 'insoleLength', 'clothingSize'].includes(key));
      if (keys.length) excludedMeasurementScopes.push({ keys, ...context });
      if (/身体(?:数值|测量|数据)/.test(excludedText)) for (const key of ['height', 'weight', 'shoeSize']) explicitExcluded.add(key);
      if (/(?:我自己|本人|my own).*(?:工作|job|career)/.test(excludedText)) explicitExcluded.add('occupation');
      continue;
    }
    excludedList = false;
    excludedMeasurementContext = null;
    const topic = /^(?:不要|别)(?:再)?(?:和|与|把|看|读|包括)/.exec(instruction);
    if (topic) {
      const topicText = instruction.slice(topic[0].length).replace(/(?:混在一起|混到一起|混淆|放在一起|带进去|放进去).*$/, '').trim();
      if (topicText.length >= 2 && topicText.length <= 40) { excludedTopics.push(topicText); continue; }
    }
    const own = ownerScope(clause);
    const named = relationSubjects(clause);
    if (named.length) inheritedSubjects = named;
    else if (own) inheritedSubjects = [];
    scopes.push(queryFieldScope(clause, inheritedSubjects));
    if (/(?:只|仅)(?:需要|读取|查询|展示|返回|看|读|要)/.test(clause)) {
      for (const field of queryFieldScope(clause).fields) onlyFields.add(field.key);
    }
    positiveClauses.push(clause);
  }
  const sharedSubjectFields = /(?:我|本人)(?:和|与|、)(?:我的)?(?:朋友|同事|伴侣|姐姐|妹妹|哥哥|弟弟|父亲|母亲)/.test(text)
    ? fieldDefinitions.filter(field => fieldQueryMatch(field, positiveClauses.join(' '))).map(field => ({ key: field.key, label: field.label, queryAlias: fieldQueryMatch(field, text)?.[0] || field.label })) : [];
  const fields = [...new Map([...scopes.flatMap(scope => scope.fields), ...sharedSubjectFields].map(field => [field.key, field])).values()].filter(field => !explicitExcluded.has(field.key));
  const includedKeys = new Set(fields.map(field => field.key));
  const excludedFields = [...new Set(scopes.flatMap(scope => scope.excludedFields))].filter(key => !includedKeys.has(key));
  // "目前为止的历史" can refer to both, so retain both rather than inventing a
  // date cutoff from the date of the request.
  const lexicalQuery = positiveClauses.join(' ');
  const current = currentCue.test(lexicalQuery);
  const historical = pastCue.test(lexicalQuery);
  const temporal = current && historical ? 'comparison' : current ? 'current' : historical ? 'historical' : 'unspecified';
  const phasePattern = /(进行中|暂时搁置|已结束)(?:的)?(?:副业|爱好|项目|条目)/;
  const phase = phasePattern.exec(lexicalQuery)?.[1] || null;
  return { fields, excludedFields, explicitExcludedFields: [...explicitExcluded], excludedMeasurementScopes, temporal,
    lexicalQuery, excludedTopics, phase,
    subjects: relationSubjects(lexicalQuery).map(({ key, label }) => ({ key, label })), subjectName: subjectName(lexicalQuery),
    ownerRequested: fields.length > 0 || ownerMeasurementRequest(lexicalQuery), onlyFields: onlyFields.size ? fields.map(field => field.key) : [] };
}

export function structuredRecallIntent(intent, scope) {
  if (scope?.includeFields === undefined) return intent;
  const fields = fieldDefinitions.filter(field => scope.includeFields.includes(field.key))
    .map(({ key, label }) => ({ key, label, queryAlias: label }));
  return { ...intent, fields, onlyFields: [], structuredFields: true,
    ownerRequested: intent.subjects.length ? intent.ownerRequested : fields.length > 0 };
}

export function memorySubjectMatch(memory, intent) {
  const text = normalize(memory.content);
  const subjects = relationSubjects(text);
  // Body/profile prefixes remain owner facts. A relation mentioned in a
  // boundary or preference does not convert the whole record to that person.
  const relationRecord = /^(?:关系资料|关系|我的朋友|我同事|我的同事|朋友|姐姐|妹妹|哥哥|弟弟|母亲|父亲|宠物)/.test(text)
    || memory.category === '关系';
  if (!relationRecord || !subjects.length) return [];
  const name = subjectName(text);
  if (intent.subjectName && name && intent.subjectName !== name) return [];
  return intent.subjects.filter(subject => subjects.some(candidate => candidate.key === subject.key));
}

export function taskScopeAllows(memory, fields, intent) {
  if (fields.some(field => intent.explicitExcludedFields.includes(field.key))) return false;
  if (intent.onlyFields.length && fields.some(field => !intent.onlyFields.includes(field.key))) return false;
  if (intent.subjects.length && !intent.ownerRequested && fields.length) return false;
  const text = normalize(memory.content);
  const measurements = measurementConcepts(text);
  const relationRecord = /^(?:关系资料|关系|我的朋友|我同事|我的同事|朋友|姐姐|妹妹|哥哥|弟弟|母亲|父亲|宠物)/.test(text) || memory.category === '关系';
  const technicalDocument = /组件|卡片|选择器|下拉|表单|输入框|字段|变量|参数|\b(?:css|html|api|component|selector|input)\b/.test(text);
  for (const excluded of intent.excludedMeasurementScopes) {
    if (!measurements.some(concept => excluded.keys.includes(concept.key))) continue;
    if (excluded.technicalOnly && !technicalDocument || excluded.ownerOnly && relationRecord) continue;
    if (excluded.subjects.length && (!relationRecord || !memorySubjectMatch(memory, { ...intent, subjects: excluded.subjects }).length)) continue;
    return false;
  }
  if (measurements.length && intent.subjects.length
    && (relationRecord ? !memorySubjectMatch(memory, intent).length : !intent.ownerRequested)) return false;
  if (measurements.length && relationRecord && !intent.subjects.length && ownerMeasurementRequest(intent.lexicalQuery)) return false;
  if (intent.subjectName && relationRecord && subjectName(text) !== intent.subjectName) return false;
  if (intent.excludedTopics.some(topic => text.includes(topic))) return false;
  const item = parseProfileItem(memory.content);
  if (intent.phase && item && item.phase !== intent.phase) return false;
  // A profile-only question does not need a component specification about the
  // same attribute. Mixed personal+technical requests can still retrieve both.
  const technicalQuery = /设计|开发|实现|组件|选择器|表单|下拉|\b(?:css|html|api|component|selector|input)\b/.test(intent.lexicalQuery);
  const extraMeasurement = measurements.some(concept => ['footLength', 'insoleLength', 'clothingSize'].includes(concept.key));
  if (technicalQuery && !technicalDocument && extraMeasurement && (!ownerMeasurementRequest(intent.lexicalQuery) || measurementFieldObject(intent.lexicalQuery))) return false;
  if (!technicalQuery && technicalDocument && !fields.some(field => intent.fields.some(requested => requested.key === field.key))) {
    const technicalFields = queryFieldScope(text).excludedFields;
    if (intent.fields.some(field => technicalFields.includes(field.key))) return false;
    if (measurementFieldObject(text) && measurementConcepts(intent.lexicalQuery)
      .some(concept => ['footLength', 'insoleLength', 'clothingSize'].includes(concept.key))) return false;
  }
  return true;
}

export function memoryRecallFields(memory) {
  const text = normalize(memory.content);
  const prefixed = fieldDefinitions.filter(field => field.prefix.test(text));
  // An explicit labeled boundary may quote another field ("不要公开我的生日").
  // Such a mention is not a second birthday fact. Free-form self statements
  // remain supported when there is no recognized structured field prefix.
  const fields = (prefixed.length ? prefixed : fieldDefinitions.filter(field => field.selfStatement.test(text)))
    .map(({ key, label }) => ({ key, label }));
  for (const field of extraFields) {
    if (memory.category === field.label && !fields.some(candidate => candidate.key === field.key)) fields.push(field);
  }
  if (careerEpisode(text)?.ownerApplicable && !fields.some(field => field.key === 'occupation')) fields.push({ key: 'occupation', label: '职业', derivedFromEpisode: true });
  return fields;
}

export function memoryMeasurementEvidence(memory) {
  const text = normalize(memory.content);
  // An explicitly labeled occupation or preference owns the words in its
  // clause. "职业：服装尺码算法工程师" names a job, not a clothing size.
  // Restrict this topic rule to those two explicit field kinds. A narrative
  // label such as 人生经历 or 自我描述 can contain a real measurement or an
  // explicit unknown, so it must not discard that clause's complete evidence.
  // Separate measurement clauses still count without requiring a number or
  // certifying a measured value.
  const contextFields = fieldDefinitions.filter(field => ['occupation', 'communication'].includes(field.key));
  const evidence = text.split(/[\n；;。，,]/)
    .filter(clause => !contextFields.some(field => field.prefix.test(clause))).join(' ');
  return measurementConcepts(evidence);
}

export function memoryTemporalEvidence(memory, requested = 'unspecified') {
  const text = normalize(memory.content);
  const career = careerEpisode(text);
  // Remove only that career line's unrelated employment segments. Other
  // explicitly labeled lines keep their existing temporal/phase behavior.
  const applicableText = career ? text.replace(career.excerpt, career.applicableText) : text;
  const evidence = [];
  let current = false;
  let historical = false;
  // Only explicit text is evidence here. updatedAt is a system recording time,
  // not the date when a job, interest, weight or other fact applied in life.
  const phase = /(?:^|\n)\s*阶段\s*[:：]\s*(进行中|暂时搁置|已结束)/.exec(applicableText)?.[1];
  if (phase) {
    evidence.push(`阶段：${phase}`);
    current = phase === '进行中';
    historical = phase === '已结束';
  }
  const end = /(?:^|\n)\s*结束时间\s*[:：]\s*(\d{4}(?:-\d{2}(?:-\d{2})?)?)(?=\s|$)/.exec(applicableText)?.[1];
  if (end) evidence.push(`结束时间：${end}`);
  // A supplied end date alone is not proof an item has already ended. It can
  // also be a plan; phase or an explicit utterance must say it is historical.
  const past = pastFact.exec(applicableText)?.[0];
  const present = currentFact.exec(applicableText)?.[0];
  if (past) { historical = true; evidence.push(`原文：${past.trim()}`); }
  if (present) { current = true; evidence.push(`原文：${present.trim()}`); }
  if (career?.historical) { historical = true; evidence.push(`职业经历有明确区间：${career.applicableText}`); }
  if (career?.current) { current = true; evidence.push(`职业经历明确持续至今：${career.applicableText}`); }
  const scope = current && historical ? 'mixed' : current ? 'current' : historical ? 'historical' : 'unspecified';
  return { requested, scope, evidence };
}

export function temporalRecallFit(temporal) {
  if (temporal.requested === 'unspecified') return temporal.scope === 'current' ? 1 : temporal.scope === 'historical' ? -1 : 0;
  if (!['current', 'historical'].includes(temporal.requested)) return 0;
  if (temporal.scope === temporal.requested) return 2;
  if (temporal.scope === 'mixed') return 1;
  if (temporal.scope === 'unspecified') return 0;
  return -1;
}

export function temporalRecallReason(temporal) {
  if (temporal.scope === 'historical') return `原文明确为过往记录（${temporal.evidence.join('；')}）`;
  if (temporal.scope === 'current') return `原文有当前状态依据（${temporal.evidence.join('；')}）`;
  if (temporal.scope === 'mixed') return '原文同时包含过去与当前状态，需按完整原文理解';
  if (temporal.requested !== 'unspecified') return '未提供明确适用时间；更新时间不代表事实生效时间';
  return '';
}
