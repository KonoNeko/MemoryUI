// Sections describe the panel hierarchy. They are presentation metadata, not
// evidence that the user has supplied any of these facts.
export const PROFILE_SECTIONS = Object.freeze([
  { key: 'identity', label: '基础身份', description: '称呼、基础属性与生活背景', icon: 'user', fields: ['name', 'age', 'gender', 'height', 'weight', 'shoeSize', 'pronouns', 'birthday', 'location', 'timezone', 'languages', 'background'] },
  { key: 'roles', label: '职业与角色', description: '主业、副业，以及你承担的职责', icon: 'briefcase', fields: ['occupation', 'role', 'sidework', 'workstyle'] },
  { key: 'interests', label: '兴趣与能力', description: '喜欢的事、积累的技能与擅长领域', icon: 'heart', fields: ['hobbies', 'skills', 'learningstyle'] },
  { key: 'values', label: '价值观与边界', description: '重视什么、如何选择，以及个人边界', icon: 'shield', fields: ['values', 'principles', 'boundaries'] },
  { key: 'goals', label: '目标与阶段', description: '当前的方向、所处阶段与动力', icon: 'spark', fields: ['goal', 'lifestage', 'motivation', 'longterm', 'constraints'] },
  { key: 'personality', label: '性格与自述', description: '用自己的话描述性格与应对方式', icon: 'message', fields: ['mbti', 'traits', 'description', 'stress'] },
  { key: 'relationships', label: '关系与支持', description: '关系中的角色，以及希望获得的支持', icon: 'link', fields: ['attachment', 'support', 'relationship'] },
  { key: 'story', label: '人生经历', description: '重要经历、转折，以及它们的意义', icon: 'clock', fields: ['milestone', 'meaning'] },
  { key: 'daily', label: '日常与使用需求', description: '生活节奏、日常偏好与使用工具时的需要', icon: 'compass', fields: ['routine', 'diet', 'activity', 'accessibility'] },
].map((section) => Object.freeze({ ...section, fields: Object.freeze(section.fields) })));

const sectionByField = new Map(PROFILE_SECTIONS.flatMap((section) => section.fields.map((key) => [key, section.key])));

// A profile field is an explicit user-authored memory, never an inferred trait.
// Original keys, labels and groups remain compatible with existing memories.
export const PROFILE_FIELDS = Object.freeze([
  { key: 'age', label: '年龄', group: 'basic', placeholder: '例如：28 岁', icon: 'clock' },
  { key: 'height', label: '身高', group: 'basic', placeholder: '例如：175 cm 或 1.75 m，请保留单位', icon: 'ruler' },
  { key: 'weight', label: '体重', group: 'basic', placeholder: '例如：65 kg 或 130 斤，请保留单位', icon: 'scale' },
  { key: 'shoeSize', label: '鞋码', group: 'basic', placeholder: '例如：EU 42 / CN 260，可注明左右脚或品牌', icon: 'shoe' },
  { key: 'occupation', label: '职业', group: 'basic', placeholder: '例如：产品设计师', icon: 'briefcase' },
  { key: 'sidework', label: '副业', group: 'basic', placeholder: '例如：独立开发', icon: 'layers', multi: true },
  { key: 'hobbies', label: '爱好', group: 'basic', placeholder: '例如：摄影', icon: 'heart', multi: true },
  { key: 'mbti', label: 'MBTI', group: 'personality', placeholder: '例如：ENFP', icon: 'spark' },
  { key: 'traits', label: '性格特质', group: 'personality', placeholder: '例如：好奇、慢热、喜欢探索', icon: 'user' },
  { key: 'attachment', label: '依恋模式', group: 'personality', placeholder: '例如：焦虑依恋', icon: 'heart' },
  { key: 'description', label: '自我描述', group: 'personality', placeholder: '用自己的话描述你', icon: 'message' },
  { key: 'milestone', label: '人生经历', group: 'timeline', placeholder: '例如：2024 年开始副业；2025 年转行做产品设计。', icon: 'clock' },
  { key: 'name', label: '称呼', group: 'basic', placeholder: '你希望被怎样称呼', icon: 'user' },
  { key: 'location', label: '居住地', group: 'basic', placeholder: '例如：上海', icon: 'user' },
  { key: 'languages', label: '语言', group: 'basic', placeholder: '例如：中文、英语', icon: 'message' },
  { key: 'background', label: '成长与教育', group: 'basic', placeholder: '希望 AI 了解的成长或教育背景', icon: 'notebook' },
  { key: 'role', label: '职责与角色', group: 'basic', placeholder: '例如：负责产品规划与团队协作', icon: 'briefcase' },
  { key: 'skills', label: '技能与擅长', group: 'basic', placeholder: '例如：写作、产品设计', icon: 'layers' },
  { key: 'values', label: '核心价值观', group: 'values', placeholder: '例如：自主、诚实、创造', icon: 'shield' },
  { key: 'principles', label: '选择原则', group: 'values', placeholder: '你做重要选择时遵循什么', icon: 'shield' },
  { key: 'boundaries', label: '个人边界', group: 'values', placeholder: '希望他人尊重的边界', icon: 'shield' },
  { key: 'goal', label: '当前目标', group: 'goals', placeholder: '现阶段最希望完成的事', icon: 'spark' },
  { key: 'lifestage', label: '人生阶段', group: 'goals', placeholder: '例如：探索职业方向', icon: 'clock' },
  { key: 'motivation', label: '动力来源', group: 'goals', placeholder: '什么让你愿意继续投入', icon: 'spark' },
  { key: 'stress', label: '压力与应对', group: 'personality', placeholder: '有压力时的表现与有效应对方式', icon: 'message' },
  { key: 'support', label: '支持需求', group: 'relationships', placeholder: '你希望怎样被倾听或支持', icon: 'heart' },
  { key: 'relationship', label: '关系角色', group: 'relationships', placeholder: '例如：朋友、伴侣、照顾者', icon: 'link' },
  { key: 'meaning', label: '经历的意义', group: 'timeline', placeholder: '某段经历如何影响了现在的你', icon: 'notebook' },
  { key: 'gender', label: '性别', group: 'basic', placeholder: '按自己的意愿填写，也可以不透露', icon: 'user' },
  { key: 'pronouns', label: '称谓与代词', group: 'basic', placeholder: '例如：直接叫我的名字；they/them', icon: 'message' },
  { key: 'birthday', label: '出生日期', group: 'basic', placeholder: '例如：1997 或 1997-04-12；不确定可留空', icon: 'calendar' },
  { key: 'timezone', label: '时区', group: 'basic', placeholder: '例如：Asia/Shanghai 或 UTC+8', icon: 'clock' },
  { key: 'workstyle', label: '工作方式', group: 'basic', placeholder: '例如：远程工作，上午专注开发', icon: 'briefcase' },
  { key: 'learningstyle', label: '学习方式', group: 'basic', placeholder: '例如：先看例子，再动手练习', icon: 'notebook' },
  { key: 'longterm', label: '长期方向', group: 'goals', placeholder: '未来几年想持续投入的方向', icon: 'route' },
  { key: 'constraints', label: '现实约束', group: 'goals', placeholder: '希望建议考虑的时间、精力或预算限制', icon: 'clock' },
  { key: 'routine', label: '作息习惯', group: 'daily', placeholder: '例如：上午做深度工作，晚上留给休息', icon: 'clock' },
  { key: 'diet', label: '饮食偏好', group: 'daily', placeholder: '希望建议考虑的饮食习惯；选填', icon: 'heart' },
  { key: 'activity', label: '活动习惯', group: 'daily', placeholder: '例如：每周徒步，偏好轻量路线', icon: 'compass' },
  { key: 'accessibility', label: '使用需求', group: 'daily', placeholder: '例如：大字号、键盘操作、文字替代音频', icon: 'shield' },
].map((field) => Object.freeze({ ...field, section: sectionByField.get(field.key) })));

const fieldsByKey = new Map(PROFILE_FIELDS.map((field) => [field.key, field]));
const fieldsByLabel = new Map(PROFILE_FIELDS.map((field) => [field.label.toLowerCase(), field]));

export const PROFILE_ITEM_PHASES = Object.freeze(['进行中', '暂时搁置', '已结束']);

// Occurrence dates keep the precision the user supplied. These boundaries let us
// reject impossible ordering without inventing a month or day for a year.
function datePeriod(value, label) {
  if (!value) return null;
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!match) throw new Error(`${label}请使用 YYYY、YYYY-MM 或 YYYY-MM-DD 格式。`);
  const year = Number(match[1]);
  const month = match[2] === undefined ? null : Number(match[2]);
  const day = match[3] === undefined ? null : Number(match[3]);
  if (year < 1 || (month !== null && (month < 1 || month > 12))) {
    throw new Error(`${label}不是有效日期。`);
  }
  const daysInMonth = (m) => [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (day !== null && (day < 1 || day > daysInMonth(month))) {
    throw new Error(`${label}不是有效日期。`);
  }
  const firstMonth = month ?? 1;
  const lastMonth = month ?? 12;
  return {
    first: year * 10000 + firstMonth * 100 + (day ?? 1),
    last: year * 10000 + lastMonth * 100 + (day ?? daysInMonth(lastMonth)),
  };
}

// Legacy comma lists are one user-authored collection. Never split them or
// assign occurrence dates from createdAt, history timestamps, or prose.
export function parseProfileItem(content) {
  if (typeof content !== 'string') return null;
  const lines = content.trim().split(/\r?\n/);
  const first = /^\s*([^：:]+?)\s*[:：]\s*(.*?)\s*$/.exec(lines[0] ?? '');
  if (!first) return null;
  const field = fieldsByLabel.get(first[1].trim().toLowerCase());
  const title = first[2].trim();
  if (!field?.multi || !title) return null;
  const item = { key: field.key, title, start: '', end: '', phase: '', notes: '', legacy: true };
  const metadata = { '开始时间': 'start', '结束时间': 'end', '阶段': 'phase' };
  const seen = new Set();
  const notes = [];
  let inNotes = false;
  for (const line of lines.slice(1)) {
    const match = /^\s*(开始时间|结束时间|阶段|详细说明)\s*[:：]\s*(.*?)\s*$/.exec(line);
    if (!inNotes && match && !seen.has(match[1])) {
      item.legacy = false;
      seen.add(match[1]);
      if (match[1] === '详细说明') {
        inNotes = true;
        notes.push(match[2]);
      } else {
        item[metadata[match[1]]] = match[1] === '阶段' && match[2] === '未注明' ? '' : match[2];
      }
    } else {
      notes.push(line);
    }
  }
  item.notes = notes.join('\n').trim();
  return item;
}

export function serializeProfileItem(key, data) {
  const field = fieldsByKey.get(key);
  if (!field?.multi) throw new Error('该字段不支持多项记录。');
  if (!data || typeof data !== 'object') throw new Error('请填写记录内容。');
  const readText = (name, label) => {
    const value = data[name];
    if (value == null) return '';
    if (typeof value !== 'string') throw new Error(`${label}必须是文字。`);
    return value.trim();
  };
  const title = readText('title', '名称');
  const start = readText('start', '开始时间');
  const end = readText('end', '结束时间');
  const phase = readText('phase', '阶段');
  const notes = readText('notes', '详细说明');
  if (!title) throw new Error('请填写名称。');
  if (/[\r\n]/.test(title)) throw new Error('名称请写在一行内，补充内容放到详细说明。');
  if (phase && !PROFILE_ITEM_PHASES.includes(phase)) throw new Error('阶段请选择进行中、暂时搁置、已结束或未注明。');
  const startPeriod = datePeriod(start, '开始时间');
  const endPeriod = datePeriod(end, '结束时间');
  if (startPeriod && endPeriod && endPeriod.last < startPeriod.first) {
    throw new Error('结束时间不能早于开始时间。');
  }
  const content = `${field.label}：${title}\n开始时间：${start}\n结束时间：${end}\n阶段：${phase || '未注明'}\n详细说明：${notes}`;
  if (content.length > 4000) throw new Error('记录内容不能超过 4000 个字符，请缩短详细说明。');
  return content;
}

export function parseProfileContent(content) {
  if (typeof content !== 'string') return null;
  const match = /^\s*([^：:\r\n]+?)\s*[:：]\s*([\s\S]+?)\s*$/.exec(content);
  if (!match) return null;
  const field = fieldsByLabel.get(match[1].trim().toLowerCase());
  const value = match[2].trim();
  return field && value ? { key: field.key, value } : null;
}

function isRealProfileMemory(memory) {
  return memory?.category === '关于我'
    && memory.confirmed === true
    && !['pending', 'rejected'].includes(memory.status)
    && typeof memory.id === 'string'
    && !memory.id.startsWith('demo-')
    && memory.source?.platform?.trim() !== '演示对话';
}

function isUnexpired(memory, now) {
  if (memory.status === 'expired') return false;
  if (memory.validUntil == null) return true;
  const expiry = Date.parse(memory.validUntil);
  return Number.isFinite(expiry) && expiry > now;
}

export function findProfileItems(memories, key) {
  if (!Array.isArray(memories) || !fieldsByKey.get(key)?.multi) return [];
  const now = Date.now();
  return memories.flatMap((memory) => {
    if (!isRealProfileMemory(memory) || !['active', 'paused'].includes(memory.status)
      || !isUnexpired(memory, now)) return [];
    const item = parseProfileItem(memory.content);
    return item?.key === key ? [{ id: memory.id, memory, ...item }] : [];
  });
}

export function findProfileRecords(memories, key) {
  if (!Array.isArray(memories) || !fieldsByKey.has(key)) return [];
  const now = Date.now();
  return memories.filter((memory) => {
    if (!isRealProfileMemory(memory) || memory.status !== 'active') return false;
    if (!isUnexpired(memory, now)) return false;
    return parseProfileContent(memory.content)?.key === key;
  });
}

// This is a view for the owner, including paused or privately scoped records.
// Sharing permissions belong to the store/context API and must not be inferred
// from a life phase, a profile field, or presence in this panel.
export function profileSectionEntries(memories, sectionKey) {
  const section = PROFILE_SECTIONS.find((entry) => entry.key === sectionKey);
  if (!Array.isArray(memories) || !section) return [];
  const fieldOrder = new Map(section.fields.map((key, index) => [key, index]));
  const now = Date.now();
  const entries = memories.flatMap((memory) => {
    if (!isRealProfileMemory(memory) || !['active', 'paused'].includes(memory.status)
      || !isUnexpired(memory, now)) return [];
    const parsed = parseProfileContent(memory.content);
    if (!parsed || !fieldOrder.has(parsed.key)) return [];
    const field = fieldsByKey.get(parsed.key);
    const item = field.multi ? parseProfileItem(memory.content) : null;
    return [{ memory, field, value: parsed.value, ...(item ? { item } : {}) }];
  });
  const recordedTime = (memory) => {
    for (const value of [memory.updatedAt, memory.createdAt]) {
      const timestamp = Date.parse(value);
      if (Number.isFinite(timestamp)) return timestamp;
    }
    return 0;
  };
  return entries.sort((a, b) => fieldOrder.get(a.field.key) - fieldOrder.get(b.field.key)
    || recordedTime(b.memory) - recordedTime(a.memory));
}

function timelineEntry(memory, history, from, to, kind) {
  const parsedFrom = parseProfileContent(from);
  const parsedTo = parseProfileContent(to);
  const fromItem = parseProfileItem(from);
  const toItem = parseProfileItem(to);
  const field = fieldsByKey.get(parsedTo?.key ?? parsedFrom?.key);
  return {
    id: history.id,
    memoryId: memory.id,
    at: history.at,
    label: field?.label ?? '关于我',
    from: from === null ? null : (parsedFrom?.key === parsedTo?.key ? fromItem?.title ?? parsedFrom?.value ?? from : from),
    to: toItem?.title ?? parsedTo?.value ?? to,
    kind,
    revision: history.revision,
    ...((fromItem || toItem) ? { fromItem, toItem } : {}),
  };
}

export function profileTimeline(memories) {
  if (!Array.isArray(memories)) return [];
  const entries = [];
  for (const memory of memories) {
    if (!isRealProfileMemory(memory) || !Array.isArray(memory.history)) continue;
    let content = null;
    let confirmed = false;
    let initialRecorded = false;
    // Replay revisions so confirmation uses its original value, not a later edit.
    const history = [...memory.history].sort((a, b) => a.revision - b.revision);
    for (const record of history) {
      const contentChange = record.changes?.content;
      if (contentChange && typeof contentChange.to === 'string') content = contentChange.to;
      if (record.changes?.confirmed) confirmed = record.changes.confirmed.to === true;

      if (record.action === 'proposed' || record.action === 'imported') {
        confirmed = false;
        continue;
      }
      if (record.action === 'stated') {
        confirmed = true;
        if (typeof content === 'string' && !initialRecorded) {
          entries.push(timelineEntry(memory, record, null, content, 'initial'));
          initialRecorded = true;
        } else if (contentChange && typeof contentChange.from === 'string' && contentChange.from !== contentChange.to) {
          entries.push(timelineEntry(memory, record, contentChange.from, contentChange.to, 'update'));
        }
        continue;
      }
      if (record.action === 'created') {
        confirmed = true;
        if (contentChange?.from === null && typeof content === 'string' && !initialRecorded) {
          entries.push(timelineEntry(memory, record, null, content, 'initial'));
          initialRecorded = true;
        }
        continue;
      }
      if (record.action === 'confirmed') {
        confirmed = true;
        if (typeof content === 'string' && !initialRecorded) {
          entries.push(timelineEntry(memory, record, null, content, 'initial'));
          initialRecorded = true;
        }
        continue;
      }
      if (record.action === 'updated' && confirmed && contentChange
        && typeof contentChange.from === 'string' && typeof contentChange.to === 'string'
        && contentChange.from !== contentChange.to) {
        entries.push(timelineEntry(memory, record, contentChange.from, contentChange.to, 'update'));
      }
    }
  }
  // These are recording times; dates mentioned inside memories remain plain text.
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)
    || b.revision - a.revision);
}
