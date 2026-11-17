// Pure profile-input helpers shared by the owner UI and local authority.
// Reading a date never edits a birthday or persists a newly calculated age.
export const GENDER_OPTIONS = Object.freeze([
  { value: '女性', label: '女性' },
  { value: '男性', label: '男性' },
  { value: '非二元', label: '非二元' },
  { value: '性别流动', label: '性别流动' },
  { value: '无性别', label: '无性别' },
  { value: '探索中', label: '探索中' },
  { value: 'custom', label: '自定义', custom: true },
  { value: '不愿透露', label: '不愿透露' },
].map(option => Object.freeze(option)));

export class ProfileAttributeError extends Error {
  constructor(message) { super(message); this.name = 'ProfileAttributeError'; this.code = 'INVALID_PROFILE_ATTRIBUTE'; }
}
const fail = message => { throw new ProfileAttributeError(message); };
const leapYear = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const monthDays = (year, month) => [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

export function userToday({ now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(date.getTime())) fail('当前日期无效，请核对日期后重试。');
  let parts;
  try { parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date); }
  catch { fail('时区无效，请核对时区后重试。'); }
  const read = type => Number(parts.find(part => part.type === type)?.value);
  const year = read('year'), month = read('month'), day = read('day');
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || !Number.isInteger(day)) fail('当前日期超出支持范围。');
  return { year, month, day, iso: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
}

export function parseBirthday(input, options = {}) {
  if (typeof input !== 'string') fail('出生日期请使用 YYYY、YYYY-MM 或 YYYY-MM-DD。');
  const value = input.trim(), match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!match) fail('出生日期请使用四位年份；只知道年或年月时保留该精度。');
  const year = Number(match[1]), month = match[2] === undefined ? null : Number(match[2]), day = match[3] === undefined ? null : Number(match[3]);
  if (year < 1 || (month !== null && (month < 1 || month > 12)) || (day !== null && (day < 1 || day > monthDays(year, month)))) fail('出生日期不存在，请核对年月日。');
  const today = userToday(options);
  if (year > today.year || (year === today.year && month !== null && (month > today.month || (month === today.month && day !== null && day > today.day)))) fail('出生日期不能晚于今天。');
  return { value, precision: day !== null ? 'day' : month !== null ? 'month' : 'year', year, month, day };
}

export function ageFromBirthday(value, options = {}) {
  if (value === undefined || value === null || value === '') return null;
  const birthday = parseBirthday(value, options);
  if (birthday.precision !== 'day') return null;
  const today = userToday(options);
  // Comparing the actual month/day intentionally means a 29 February birthday
  // is reached on 1 March in a non-leap year, rather than on 28 February.
  return today.year - birthday.year - Number(today.month < birthday.month || (today.month === birthday.month && today.day < birthday.day));
}

export function validateAge(value) {
  let age;
  if (typeof value === 'number') age = value;
  else if (typeof value === 'string') {
    const match = /^(\d{1,3})(?:\s*(?:岁|years?(?:\s+old)?|y))?$/i.exec(value.trim());
    if (match) age = Number(match[1]);
  }
  if (!Number.isInteger(age) || age < 0 || age > 130) fail('年龄请填写 0–130 之间的整数。');
  return age;
}

const MEASUREMENTS = Object.freeze({
  height: { label: '身高', example: '175 cm 或 1.75 m' },
  weight: { label: '体重', example: '65 kg 或 130 斤' },
  shoeSize: { label: '鞋码', example: 'EU 42 或 CN 260' },
});
const QUANTITIES = /[+\-−]?\s*(?:\d+(?:\.\d+)?|\.\d+)/g;
function measurementCore(text) {
  // Remarks are retained in the returned value. Exclude a clearly annotated
  // parenthesis only from numeric checks, keeping compound quantities such as
  // 5 ft (9 in) and parenthesized units such as 175 (cm) measurable.
  return text.replace(/[（(\[【]([^（）()\[\]【】]*)[）)\]】]/g, (whole, inner) =>
    /(?:\d{4}[-/]\d{1,2}|测量|测得|记录|备注|误差|年|月|日期|measured|recorded|note|as of)/i.test(inner) ? '' : whole)
    .replace(/\b\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?\b/g, '')
    .replace(/\d{4}年(?:\d{1,2}月)?(?:\d{1,2}日)?/g, '');
}

export function validateProfileAttribute(key, value, options = {}) {
  if (key === 'age') return `${validateAge(value)} 岁`;
  if (key === 'birthday') return parseBirthday(value, options).value;
  if (typeof value !== 'string' || !value.trim() || value.length > 4000) fail('请填写非空内容，且不超过 4000 个字符。');
  const text = value.trim();
  if (key === 'gender') {
    if (text === 'custom' || text === '自定义') fail('请填写自己的性别描述，也可以选择不愿透露。');
    if (text.length > 100) fail('性别描述请控制在 100 个字符内。');
    return text;
  }
  const measurement = MEASUREMENTS[key];
  if (measurement) {
    if (/[\x00-\x1f\x7f]/.test(text)) fail(`${measurement.label}请使用可见的单行文字。`);
    const core = measurementCore(text), numbers = core.match(QUANTITIES) ?? [];
    if (!numbers.length || numbers.some(number => !Number.isFinite(Number(number.replace(/\s/g, '').replace('−', '-'))) || Number(number.replace(/\s/g, '').replace('−', '-')) <= 0)) fail(`${measurement.label}请填写正数，并保留单位或尺码体系。`);
    // Units and size systems are user-authored, not a closed conversion table.
    // Require visible unit text/symbols besides the actual positive quantities.
    const unitText = core.replace(QUANTITIES, '').replace(/[\s.,+\-−/\\()\[\]{}（）【】]/g, '');
    if (!/[\p{L}\p{S}'"′″]/u.test(unitText) || unitText.length > 100) fail(`${measurement.label}请保留清晰的单位或体系，例如 ${measurement.example}；自定义单位不超过100字。`);
    return text;
  }
  return text;
}
