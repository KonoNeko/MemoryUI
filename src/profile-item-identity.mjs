import { PROFILE_FIELDS, parseProfileItem, serializeProfileItem } from './profile-model.js';

export function profileItemForWrite(content, category) {
  if (category !== '关于我') return null;
  const item = parseProfileItem(content);
  const label = /^\s*([^：:\r\n]+?)\s*[:：]/.exec(content)?.[1].trim().toLowerCase();
  if (PROFILE_FIELDS.some(field => field.multi && field.label.toLowerCase() === label) && !item) {
    throw new Error('副业或爱好的名称不能为空，时间和说明应写在对应行。');
  }
  if (item && !item.legacy) serializeProfileItem(item.key, item);
  return item;
}

// Date precision is evidence, not an exact inferred day. Overlapping starts
// (2024 / 2024-03 / 2024-03-12) cannot establish separate episodes.
function startPeriod(item) {
  if (!item.start) return null;
  try { serializeProfileItem(item.key, item); } catch { return null; }
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(item.start);
  if (!match) return null;
  const year = Number(match[1]), month = match[2] ? Number(match[2]) : null, day = match[3] ? Number(match[3]) : null;
  const lastMonth = month ?? 12;
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return { first: year * 10000 + (month ?? 1) * 100 + (day ?? 1), last: year * 10000 + lastMonth * 100 + (day ?? days[lastMonth - 1]) };
}

export function profileItemStartsDisjoint(first, second) {
  const a = startPeriod(first), b = startPeriod(second);
  return Boolean(a && b && (a.last < b.first || b.last < a.first));
}

export function profileItemCollision(previous, incoming) {
  if (previous?.category !== '关于我' || incoming?.category !== '关于我' || previous.content === incoming.content) return false;
  const before = parseProfileItem(previous.content), after = parseProfileItem(incoming.content);
  if (!before || !after || before.key !== after.key
    || before.title.normalize('NFKC').trim() !== after.title.normalize('NFKC').trim()) return false;
  return !profileItemStartsDisjoint(before, after);
}
