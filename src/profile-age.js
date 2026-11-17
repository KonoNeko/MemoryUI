import { parseProfileContent } from './profile-model.js';
import { ageFromBirthday, userToday, validateAge } from './profile-attributes.js';
import { memoryEvidenceRef } from './memory-evidence.mjs';

// These views never enter storage. The original birthday remains the only
// evidence and permission source; callers cannot manufacture a projection by
// adding JSON properties to a memory.
const ageProjections = new WeakMap();

function profileValue(memory, key) {
  const parsed = parseProfileContent(memory?.content);
  if (parsed?.key === key) return parsed.value;
  const aliases = key === 'age' ? /^(?:年纪|age)\s*[:：]\s*(.+)$/iu
    : /^(?:生日|birthday|birth date)\s*[:：]\s*(.+)$/iu;
  return typeof memory?.content === 'string' ? aliases.exec(memory.content.trim())?.[1]?.trim() ?? null : null;
}

function eligible(memory, now) {
  return memory?.category === '关于我'
    && typeof memory.id === 'string' && !memory.id.startsWith('demo-')
    && memory.source?.platform?.trim() !== '演示对话'
    && (memory.confirmed === true ? ['active', 'paused'] : ['active', 'pending']).includes(memory.status)
    && (!memory.validUntil || Number.isFinite(Date.parse(memory.validUntil)) && Date.parse(memory.validUntil) > now);
}

function contentTime(memory) {
  // Sharing/type edits also change updatedAt; they must not make an old age
  // statement newer than an explicitly corrected birthday.
  const evidence = memoryEvidenceRef(memory);
  const value = evidence.recordedAt ?? memory.updatedAt ?? memory.createdAt;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

const conflicted = memory => memory.supersedes || memory.reviewReasons?.includes('conflict');

/** A source-backed current age, or null when direct age/ambiguity must win. */
export function resolveProfileAge(memories, { now = new Date(), timeZone } = {}) {
  if (!Array.isArray(memories)) return null;
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) return null;
  const options = { now: instant, ...(timeZone === undefined ? {} : { timeZone }) };
  const current = memories.filter(memory => eligible(memory, instant.getTime()));
  const birthdays = current.filter(memory => profileValue(memory, 'birthday') !== null);
  // Even two parseable records with the same date require an owner decision:
  // neither source revision is silently selected or merged.
  if (birthdays.length !== 1 || conflicted(birthdays[0])) return null;
  const sourceMemory = birthdays[0], birthday = profileValue(sourceMemory, 'birthday');
  let age, asOfDate;
  try { age = ageFromBirthday(birthday, options); asOfDate = userToday(options).iso; }
  catch { return null; }
  if (!Number.isInteger(age) || age < 0 || age > 130) return null;
  const ages = current.filter(memory => profileValue(memory, 'age') !== null);
  const confirmedAges = ages.filter(memory => memory.confirmed === true);
  if (sourceMemory.confirmed !== true && confirmedAges.length) return null;
  const primaryAges = confirmedAges.length ? confirmedAges : ages;
  if (primaryAges.length > 1) return null;
  if (primaryAges.length) {
    const manual = primaryAges[0];
    if (conflicted(manual)) return null;
    let suppliedAge;
    try { suppliedAge = validateAge(profileValue(manual, 'age')); }
    catch { return null; }
    const ageAt = contentTime(manual), birthdayAt = contentTime(sourceMemory);
    if (ageAt === null || birthdayAt === null) return null;
    // A newer birthday correction is usable without rewriting the older age.
    // Otherwise a newer inconsistent explicit age remains the displayed fact.
    if (birthdayAt <= ageAt) {
      let ageOnStatementDate;
      try { ageOnStatementDate = ageFromBirthday(birthday, { ...options, now: new Date(ageAt) }); }
      catch { return null; }
      if (suppliedAge !== ageOnStatementDate) return null;
    }
  }
  return { value: `${age} 岁`, sourceMemory, birthdayId: sourceMemory.id,
    reference: sourceMemory.confirmed !== true, asOfDate };
}

export function projectProfileAgeForRecall(memories, { enabled = false, now = new Date(), timeZone, excludeBirthday = false } = {}) {
  if (!enabled || excludeBirthday) return memories;
  const resolved = resolveProfileAge(memories, { now, timeZone });
  if (!resolved) return memories;
  const source = resolved.sourceMemory;
  const projected = Object.freeze({ ...source, content: `年龄：${resolved.value}` });
  const options = Object.freeze({ now: new Date(now).toISOString(), ...(timeZone === undefined ? {} : { timeZone }) });
  ageProjections.set(projected, Object.freeze({ ...resolved, options }));
  // The explicit age remains stored and can still be inspected by ID. A
  // current-age recall must not return that older value beside today's view.
  return memories.filter(memory => profileValue(memory, 'age') === null)
    .map(memory => memory === source ? projected : memory);
}

export function profileAgeProjection(memory) { return ageProjections.get(memory) ?? null; }

// Used only by the authority's internal read-audit path. Re-resolve against
// today's authorized records instead of accepting a caller's derived content.
export function validateProfileAgeReadView(view, readableMemories, { kind, scope } = {}) {
  const projection = profileAgeProjection(view);
  if (!projection) return null;
  if (kind !== 'recall' || scope?.excludeFields?.includes('birthday')) throw new Error('INVALID_AGE_PROJECTION');
  const resolved = resolveProfileAge(readableMemories, projection.options);
  if (!resolved || resolved.birthdayId !== view.id || resolved.value !== projection.value
    || resolved.sourceMemory.revision !== projection.sourceMemory.revision
    || resolved.sourceMemory.content !== projection.sourceMemory.content) throw new Error('STALE_AGE_PROJECTION');
  return projectProfileAgeForRecall(readableMemories, { ...projection.options, enabled: true })
    .find(memory => profileAgeProjection(memory)?.birthdayId === resolved.birthdayId) ?? null;
}
