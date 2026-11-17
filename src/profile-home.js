import { icon } from './icons.js';
import { PROFILE_FIELDS, PROFILE_SECTIONS, profileSectionEntries, profileTimeline, parseProfileContent, parseProfileItem } from './profile-model.js';
import { isUsableMemory } from './memory-policy.js';
import { GENDER_OPTIONS, validateAge } from './profile-attributes.js';
import { resolveProfileAge } from './profile-age.js';
import { getProfilePickerState } from './profile-pickers.js';

const esc = (value = '') => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const text = (value, limit = 130) => { const clean = String(value || '').replace(/\s+/g, ' ').trim(); return clean.length > limit ? `${clean.slice(0, limit)}…` : clean; };
const control = (label, action, value, className = '', symbol = 'arrow', memoryId = '', accessibleLabel = '') => `<button type="button" class="${className}" data-action="${action}"${value ? ` data-value="${esc(value)}"` : ''}${memoryId ? ` data-id="${esc(memoryId)}"` : ''}${accessibleLabel ? ` aria-label="${esc(accessibleLabel)}"` : ''}>${label}${symbol ? icon(symbol, 15) : ''}</button>`;
const paused = records => {
  const count = records.filter(entry => entry.memory.status === 'paused').length;
  return count ? `<span class="home-paused">${records.length > 1 ? `${count} 条记录已暂停 AI 读取` : 'AI 读取已暂停'}</span>` : '';
};
const portrait = `<svg class="home-portrait-art" viewBox="0 0 256 256" aria-hidden="true" focusable="false"><defs><linearGradient id="home-avatar-field" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#e8edff"/><stop offset="1" stop-color="#d6edea"/></linearGradient><linearGradient id="home-avatar-body" x1="0" y1="0" x2="0.8" y2="1"><stop stop-color="#6579bd"/><stop offset="1" stop-color="#35499c"/></linearGradient></defs><circle cx="128" cy="128" r="105" fill="url(#home-avatar-field)"/><circle cx="128" cy="128" r="94" fill="none" stroke="#8fa6ce" stroke-dasharray="2 7"/><path d="M28 128h16m168 0h16M128 28v16m0 168v16" stroke="#6c86b4" stroke-width="1.5"/><circle cx="128" cy="110" r="36" fill="#5268ac"/><path d="M63 208c2-40 24-62 65-62s63 22 65 62" fill="url(#home-avatar-body)"/><path d="M104 152c6 14 13 21 24 21s18-7 24-21" fill="none" stroke="#d9e8ff" stroke-width="2"/><path d="m200 54 3 8 8 3-8 3-3 8-3-8-8-3 8-3Z" fill="#238274"/><circle cx="51" cy="187" r="4" fill="#4a9d8f"/><path d="M79 217h98" stroke="#8fa6ce" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const fieldSymbols = { location: 'compass', languages: 'message', timezone: 'clock', pronouns: 'message', role: 'briefcase', skills: 'layers', mbti: 'spark', attachment: 'link', traits: 'user', goal: 'target', lifestage: 'route', motivation: 'spark', workstyle: 'briefcase', learningstyle: 'notebook', longterm: 'route', constraints: 'clock', routine: 'clock', diet: 'heart', activity: 'compass', accessibility: 'shield' };
const profileFields = new Map(PROFILE_FIELDS.map(field => [field.key, field]));
const shortFields = new Set(['age', 'gender', 'height', 'weight', 'shoeSize', 'occupation', 'name', 'location', 'languages', 'timezone', 'pronouns', 'birthday']);
const unitOptions = {
  height: ['cm', 'm', 'mm', 'ft', 'in'],
  weight: ['kg', '斤', 'lb', 'g'],
  shoeSize: ['EU', 'CN', 'US', 'UK', 'JP', 'KR', 'mm', 'cm', '码'],
};

// Split only a single, explicit number and unit. Composite measurements and
// qualifiers stay intact; changing a control must never silently convert them.
export function profileInlineControlState(key, rawValue = '', overrides = {}) {
  const original = String(rawValue ?? ''), trimmed = original.trim();
  let state = { value: original };
  if (key === 'gender') {
    const option = trimmed === '女' ? '女性' : trimmed === '男' ? '男性' : trimmed;
    const known = GENDER_OPTIONS.some(item => !item.custom && item.value === option);
    state = { value: original, genderOption: !trimmed ? '' : known ? option : 'custom', customValue: !known ? original : '' };
  } else if (unitOptions[key]) {
    const units = unitOptions[key];
    const pattern = units.map(unit => unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const prefix = new RegExp(`^(${pattern})\\s*(\\d+(?:\\.\\d+)?)$`, 'i').exec(trimmed);
    const suffix = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(${pattern})$`, 'i').exec(trimmed);
    const suppliedUnit = prefix?.[1] || suffix?.[2];
    const canonicalUnit = suppliedUnit && units.find(unit => unit.toLowerCase() === suppliedUnit.toLowerCase());
    state = { value: prefix?.[2] || suffix?.[1] || original, unit: canonicalUnit || (!trimmed ? units[0] : ''), unitCustom: '' };
  } else if (key === 'age' && trimmed) {
    try { state.value = String(validateAge(trimmed)); }
    catch { /* Keep unrecognized legacy text available for an explicit edit. */ }
  }
  const result = { ...state, ...overrides };
  // A newly selected custom option can temporarily compose to an empty string
  // while the owner is still typing its text. Preserve the selected control.
  if (key === 'gender' && overrides.value !== undefined && overrides.genderOption === undefined) {
    const option = overrides.value === '女' ? '女性' : overrides.value === '男' ? '男性' : overrides.value;
    if (option === '' || GENDER_OPTIONS.some(item => item.value === option)) result.genderOption = option;
  }
  return result;
}

// Disambiguate only repeated names within one multi-value field. These are
// owner-provided event dates, never the memory's recording or update time.
// A record number breaks remaining ties without inventing another life event.
export function profileItemCues(items) {
  const names = new Map();
  for (const item of items) {
    const name = String(item.title || '').trim().replace(/\s+/g, ' ');
    if (!names.has(name)) names.set(name, []);
    names.get(name).push(item);
  }
  const cues = new Map();
  for (const group of names.values()) {
    if (group.length < 2) continue;
    const periods = new Map();
    for (const item of group) {
      const start = String(item.start || '').trim(), end = String(item.end || '').trim();
      const period = start && end ? `${start}–${end}` : start ? `${start} 起` : end ? `结束于 ${end}` : '时间未注明';
      if (!periods.has(period)) periods.set(period, []);
      periods.get(period).push(item);
    }
    for (const [period, matches] of periods) {
      // IDs make the presentation-only ordinal stable when a record is edited
      // and the enclosing list is sorted by its latest modification time.
      const ordered = [...matches].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      ordered.forEach((item, index) => cues.set(item.id, `${period}${ordered.length > 1 ? ` · 记录 ${index + 1}` : ''}`));
    }
  }
  return cues;
}

export function profileItemDisplayName(item, cues) {
  const cue = cues.get(item.id);
  return `${item.title}${cue ? `（${cue}）` : ''}`;
}

const phaseVisuals = new Map([
  ['进行中', { tone: 'active', symbol: 'refresh' }],
  ['暂时搁置', { tone: 'on-hold', symbol: 'pause' }],
  ['已结束', { tone: 'ended', symbol: 'check' }],
]);

export function profileItemPhaseBadge(phase, className = 'profile-phase') {
  if (typeof phase !== 'string' || !phase) return '';
  const visual = phaseVisuals.get(phase);
  return `<span class="${esc(className)}${visual ? ` profile-episode-phase phase-${visual.tone}` : ''}">${visual ? icon(visual.symbol, 12) : ''}${esc(phase)}</span>`;
}

// A reference can fill a visible gap, while confirmed owner records remain
// primary. This presentation never confirms, merges, edits or grants a record.
export function profileHomeReferenceEntries(memories) {
  if (!Array.isArray(memories)) return [];
  const confirmedKeys = new Set(PROFILE_SECTIONS.flatMap(section => profileSectionEntries(memories, section.key)).map(entry => entry.field.key));
  return memories.flatMap(memory => {
    if (memory?.confirmed !== false || memory.category !== '关于我' || !isUsableMemory(memory)
      || typeof memory.id !== 'string' || memory.id.startsWith('demo-') || memory.source?.platform?.trim() === '演示对话') return [];
    const parsed = parseProfileContent(memory.content), field = parsed && profileFields.get(parsed.key);
    if (!field || confirmedKeys.has(field.key)) return [];
    const item = field.multi ? parseProfileItem(memory.content) : null;
    return [{ memory, field, value: parsed.value, reference: true, ...(item ? { item } : {}) }];
  }).sort((left, right) => (Date.parse(right.memory.updatedAt || right.memory.createdAt) || 0) - (Date.parse(left.memory.updatedAt || left.memory.createdAt) || 0)
    || left.memory.id.localeCompare(right.memory.id));
}

// Owner-facing summary. Displaying private or paused confirmed records and
// labelled references does not change which agents are allowed to read them.
export function profileHomePage(snapshot, { inline = null, dirtyFieldKeys = [], moreAttributesOpen = false, referenceDetailsOpenKeys = [], basicOnly = false, now, timeZone } = {}) {
  const dirtyKeys = new Set(dirtyFieldKeys);
  const memories = Array.isArray(snapshot?.memories) ? snapshot.memories : [];
  const sections = new Map(PROFILE_SECTIONS.map(section => [section.key, profileSectionEntries(memories, section.key)]));
  const referenceEntries = profileHomeReferenceEntries(memories);
  const openReferences = new Set(referenceDetailsOpenKeys);
  const referenceBadge = '<span class="home-reference-badge">参考</span>';
  const derivedAge = resolveProfileAge(memories, { now, timeZone });
  const all = [...sections.values()].flat().concat(referenceEntries);
  const entries = key => all.filter(entry => entry.field.key === key);
  const referenceOnly = records => records.length > 0 && records.every(entry => entry.reference);
  const summary = (key, fallback = '还未记录') => {
    const values = entries(key);
    return values.length === 1 ? values[0].item?.title || values[0].value : values.length > 1 ? `${values.length} 条${referenceOnly(values) ? '参考' : '记录'}` : fallback;
  };
  const confirmReference = (entry, key, label, wording = '参考 · 确认') => {
    const memory = entry?.memory;
    if (!memory || memory.confirmed !== false) return '';
    const editing = inline?.id === memory.id;
    const busy = dirtyKeys.has(key) || editing && (inline.dirty || inline.saving || inline.stale || inline.unavailable || inline.error || ['dirty', 'saving', 'error'].includes(inline.autosaveStatus ?? inline.saveStatus));
    const validRevision = Number.isSafeInteger(memory.revision) && memory.revision > 0;
    const reason = busy ? '先完成当前修改，再确认原值' : !validRevision ? '资料版本待核对，请查看详情' : `确认${label}参考：${text(entry.item?.title || entry.value || '', 110)}`;
    return `<button type="button" class="home-reference-confirm-control" data-action="confirm-reference" data-id="${esc(memory.id)}" data-revision="${validRevision ? memory.revision : ''}" data-field="${esc(key)}" aria-label="${esc(reason)}" title="${esc(reason)}"${busy || !validRevision ? ' disabled' : ''}>${wording}</button>`;
  };
  const singleReferenceConfirm = (key, label, records) => referenceOnly(records) && records.length === 1 ? confirmReference(records[0], key, label) : '';
  const referenceDetails = (key, label, records, { minimum = 2 } = {}) => referenceOnly(records) && records.length >= minimum ? `<details class="home-reference-details" data-key="home-reference:${esc(key)}"${openReferences.has(key) ? ' open' : ''}><summary><span>${icon('spark', 14)}${esc(label)} · ${records.length} 条参考，逐条确认</span>${icon('down', 13)}</summary><div>${records.map(entry => {
    const platform = /codex/i.test(entry.memory.source?.platform || '') ? 'Codex' : /claude/i.test(entry.memory.source?.platform || '') ? 'Claude Code' : /workbuddy/i.test(entry.memory.source?.platform || '') ? 'WorkBuddy' : /chatgpt/i.test(entry.memory.source?.platform || '') ? 'ChatGPT' : '已保存的来源';
    return `<div class="home-reference-source"><span>${esc(entry.item?.title || entry.value)}</span>${control(`${esc(platform)} · 查看依据`, 'open-profile-record', '', 'home-reference-source-link', 'arrow', entry.memory.id)}${confirmReference(entry, key, label, '确认')}</div>`;
  }).join('')}</div></details>` : '';
  const inlineEditor = (key, label, { compact = false, displayKey = key } = {}) => {
    const active = inline?.key === key;
    if (!active) return '';
    const metadata = profileFields.get(key);
    if (compact) {
      const overrides = inline.pickerControls || Object.fromEntries(['year', 'month', 'day', 'country', 'region', 'city', 'pickerMode', 'unit', 'unitCustom', 'genderOption', 'customValue'].filter(name => inline[name] !== undefined).map(name => [name, inline[name]]));
      const picker = getProfilePickerState(key, inline.value, overrides, { now, timeZone });
      const state = key === 'gender' ? profileInlineControlState(key, inline.value, overrides) : picker.controls;
      const requestedStatus = inline.autosaveStatus ?? inline.saveStatus;
      const saveStatus = inline.stale || inline.unavailable ? 'error' : inline.saving ? 'saving' : inline.error ? 'error' : ['idle', 'dirty', 'saving', 'saved', 'error'].includes(requestedStatus) ? requestedStatus : inline.dirty ? 'dirty' : 'idle';
      const statusLabels = { idle: '', dirty: '待保存', saving: '保存中', saved: '已保存', error: '未保存' };
      const statusDescription = saveStatus === 'error' ? inline.stale || inline.unavailable ? '资料已变化，输入已保留，可查看详情' : '暂未保存，输入已保留，可继续修改或查看详情' : statusLabels[saveStatus];
      const attributes = `id="home-inline-value" name="value" required aria-label="${esc(label)}" aria-describedby="home-autosave-status"${saveStatus === 'error' ? ' aria-invalid="true"' : ''}`;
      const genderSelect = `<select ${attributes}>${[{ value: '', label: '请选择' }, ...GENDER_OPTIONS].map(option => `<option value="${esc(option.value)}"${state.genderOption === option.value ? ' selected' : ''}>${esc(option.value === '女性' ? '女' : option.value === '男性' ? '男' : option.custom ? '其他／自定义' : option.label)}</option>`).join('')}</select>`;
      const customGender = key === 'gender' && state.genderOption === 'custom';
      const select = (name, id, accessibleLabel, options, value = '', empty = '选择') => {
        const selected = String(value ?? '');
        const choices = [{ value: '', label: empty }, ...(options || [])];
        if (selected && !choices.some(option => String(option.value) === selected)) choices.push({ value: selected, label: `${selected}（原值）` });
        return `<select id="${id}" name="${name}" aria-label="${esc(accessibleLabel)}" aria-describedby="home-autosave-status" title="${esc(accessibleLabel)}">${choices.map(option => `<option value="${esc(option.value)}"${selected === String(option.value) ? ' selected' : ''}>${esc(option.label)}</option>`).join('')}</select>`;
      };
      const customInput = (visible, inputLabel = `补充${label}`) => `<input id="home-inline-custom-value" data-picker-custom-value name="customValue" type="text"${visible ? ' required' : ' hidden'} maxlength="3900" aria-label="${esc(inputLabel)}" aria-describedby="home-autosave-status" placeholder="补充其他" value="${esc(state.customValue ?? '')}">`;
      let extra = '', input = '', labelFor = 'home-inline-value';
      if (key === 'gender') {
        input = `${genderSelect}${customInput(customGender, '自定义性别')}`;
      } else if (picker.mode === 'birthday') {
        extra = select('pickerMode', 'home-picker-mode', '生日填写方式', [{ value: 'structured', label: '年月日' }, { value: 'custom', label: '补充其他' }], state.pickerMode, '方式');
        input = `<input id="home-inline-value" name="value" type="hidden" value="${esc(state.value)}"><div class="home-picker-parts home-picker-birthday" data-picker-panel="structured" role="group" aria-label="生日年月日"${state.pickerMode === 'custom' ? ' hidden' : ''}>${select('year', 'home-picker-year', '出生年', picker.options.years, state.year, '年')}${select('month', 'home-picker-month', '出生月', picker.options.months, state.month, '月')}${select('day', 'home-picker-day', '出生日', picker.options.days, state.day, '日')}</div><div class="home-picker-custom-panel" data-picker-panel="custom"${state.pickerMode === 'custom' ? '' : ' hidden'}>${customInput(state.pickerMode === 'custom', '补充出生日期')}</div>`;
        labelFor = state.pickerMode === 'custom' ? 'home-inline-custom-value' : 'home-picker-year';
      } else if (picker.mode === 'location') {
        const customLocation = state.country === 'custom';
        input = `<input id="home-inline-value" name="value" type="hidden" value="${esc(state.value)}"><div class="home-picker-parts home-picker-location" role="group" aria-label="居住地国家地区与城市">${select('country', 'home-picker-country', '居住国家或地区', picker.options.countries, state.country, '国家')}<span class="home-picker-location-nested" data-picker-location-nested${customLocation ? ' hidden' : ''}>${select('region', 'home-picker-region', '居住省州地区', picker.options.regions, state.region, '省州')}${select('city', 'home-picker-city', '居住城市', picker.options.cities, state.city, '城市')}</span>${customInput(customLocation, '补充居住地')}</div>`;
        labelFor = 'home-picker-country';
      } else if (['number', 'measurement', 'choice'].includes(picker.mode)) {
        input = `<span class="home-picker-value-pair">${select('value', 'home-inline-value', label, picker.options.values, state.value, '选择')}${customInput(state.value === 'custom')}</span>`;
        if (picker.mode === 'measurement') input += `<span class="home-picker-unit-pair">${select('unit', 'home-inline-unit', `${label}单位或体系`, picker.options.units, state.unit, '单位')}<input id="home-inline-unit-custom" data-picker-custom-unit name="unitCustom" type="text"${state.unit === 'custom' ? ' required' : ' hidden'} maxlength="30" aria-label="补充${esc(label)}单位或体系" placeholder="单位" value="${esc(state.unitCustom ?? '')}"></span>`;
      } else {
        input = `<input ${attributes} type="text" value="${esc(state.value)}" maxlength="3900" placeholder="${esc(metadata?.placeholder || '')}">`;
      }
      return `<form id="home-inline-form" class="home-inline-form home-inline-compact" data-key="${esc(key)}" data-display-key="${esc(displayKey)}" data-home-picker="${key === 'gender' ? 'gender' : picker.mode || 'text'}">
        <div class="home-inline-compact-heading"><label for="${labelFor}">${esc(label)}</label>${inline.reference ? key === 'birthday' && displayKey === 'age' ? referenceBadge : confirmReference({ memory: memories.find(memory => memory.id === inline.id), value: inline.value }, key, label) || referenceBadge : ''}${extra}<span id="home-autosave-status" data-home-autosave-status data-inline-status data-status="${saveStatus}" class="home-autosave-status" role="status" aria-live="polite" aria-atomic="true" aria-label="${esc(statusDescription)}" title="${esc(statusDescription)}">${statusLabels[saveStatus]}</span>${control(`<span class="sr-only">查看${esc(label)}详情</span>`, 'home-field', key, 'home-inline-detail', 'arrow', inline.id || '', `查看${label}的来源与变迁`)}</div>
        <div class="home-inline-compact-row"><div class="home-inline-inputs">${input}</div></div>
      </form>`;
    }
    const describedBy = `home-inline-help${inline.error ? ' home-inline-error' : ''}${inline.stale ? ' home-inline-stale' : ''}`;
    const attributes = `id="home-inline-value" name="value" maxlength="3900" required aria-describedby="${describedBy}"${inline.error ? ' aria-invalid="true"' : ''}${inline.saving ? ' disabled' : ''} placeholder="${esc(metadata?.placeholder || '')}"`;
    const input = shortFields.has(key) && !/[\r\n]/.test(String(inline.value ?? ''))
      ? `<input ${attributes} type="text" value="${esc(inline.value ?? '')}"${key === 'gender' ? ' list="home-inline-gender-options"' : ''}${key === 'age' ? ' inputmode="numeric"' : ''}>`
      : `<textarea ${attributes} rows="3">${esc(inline.value ?? '')}</textarea>`;
    return `<form id="home-inline-form" class="home-inline-form" data-key="${esc(key)}">
      <div class="home-inline-heading"><span>${icon('edit', 16)}就地修改</span>${inline.reference ? confirmReference({ memory: memories.find(memory => memory.id === inline.id), value: inline.value }, key, label) : ''}<span id="home-inline-status" data-inline-status class="home-inline-status${inline.dirty ? ' is-dirty' : ''}" role="status">${inline.dirty ? '未保存' : '正在编辑'}</span></div>
      <label for="home-inline-value">${esc(label)}</label>${input}
      ${key === 'gender' ? '<datalist id="home-inline-gender-options"><option value="女"></option><option value="男"></option><option value="非二元"></option><option value="不愿透露"></option></datalist>' : ''}
      <p id="home-inline-help" class="home-inline-help">${inline.reference ? '保存后作为你的本人陈述' : inline.id ? '保留现有授权' : '默认仅自己可见'} · 保存后留在主页${key === 'gender' ? '。可自由填写或不透露。' : '。'}</p>
      ${inline.error ? `<p id="home-inline-error" class="home-inline-error" role="alert">${icon('info', 15)}${esc(inline.error)}</p>` : ''}
      ${inline.stale ? `<div id="home-inline-stale" class="home-inline-stale"><span>资料已有变化，先读入最新值。</span><button type="button" data-action="home-inline-reload" data-value="${esc(key)}"${inline.unavailable || inline.saving ? ' disabled' : ''}>${icon('refresh', 15)}读入最新值</button></div>` : ''}
      <div class="home-inline-actions"><button type="submit" class="home-inline-save"${inline.stale || inline.unavailable || inline.saving ? ' disabled' : ''}>${icon('check', 16)}${inline.saving ? '保存中…' : `保存${esc(label)}`}</button><button type="button" class="home-inline-cancel" data-action="home-inline-cancel" data-value="${esc(key)}"${inline.saving ? ' disabled' : ''}>取消</button></div>
      ${control('查看详情', 'home-field', key, 'home-inline-detail', 'arrow', inline.id || '')}
    </form>`;
  };
  const detailControl = (key, label, records, className = 'home-property-detail') => `<button type="button" class="${className}" data-action="${referenceOnly(records) && records.length === 1 ? 'open-profile-record' : 'home-field'}" data-value="${esc(key)}"${records.length === 1 ? ` data-id="${esc(records[0].memory.id)}"` : ''} aria-label="查看${esc(label)}的来源与变迁" title="查看来源与变迁">${icon('arrow', 15)}</button>`;
  const valueControl = (key, label, records, className, value, labelMarkup = '') => {
    const reference = referenceOnly(records);
    const memory = records.length === 1 ? records[0].memory : null;
    const hasDraft = dirtyKeys.has(key);
    const draftBadge = hasDraft ? '<span class="home-draft-badge">草稿</span>' : '';
    const action = reference ? records.length === 1 ? 'home-edit-field' : 'home-field' : records.length > 1 ? 'home-field' : 'home-edit-field';
    const actionLabel = reference ? records.length === 1 ? `修改${label}参考：${value}，保存时确认当前值` : `查看${label}的 ${records.length} 条参考`
      : records.length > 1 ? `查看${label}的 ${records.length} 条记录${hasDraft ? '，有未保存草稿' : ''}`
      : hasDraft ? `${memory ? '继续修改' : '继续填写'}${label}，有未保存草稿${memory ? `；已保存值：${value}` : ''}`
      : memory ? `修改${label}：${value}` : `填写${label}`;
    return `<button type="button" class="${className}${records.length ? '' : ' is-empty'}${hasDraft ? ' has-draft' : ''}${reference ? ' is-reference' : ''}" data-action="${action}" data-value="${esc(key)}"${memory ? ` data-id="${esc(memory.id)}"` : ''} aria-label="${esc(actionLabel)}" title="${esc(hasDraft ? actionLabel : records.length ? value : `填写${label}`)}">${labelMarkup ? `<span class="home-value-label-row">${labelMarkup}${draftBadge}${reference && records.length > 1 ? referenceBadge : ''}</span>` : ''}<span class="home-value-content"><strong>${esc(text(value, 150))}</strong>${labelMarkup ? '' : `${draftBadge}${reference && records.length > 1 ? referenceBadge : ''}`}${icon(reference ? 'info' : records.length > 1 ? 'layers' : memory ? 'edit' : 'plus', 13)}</span>${paused(records)}</button>`;
  };
  const field = (key, label, fallback = '未记录') => {
    const records = entries(key);
    if (inline?.key === key) return `<div class="home-field-group home-field-group-${key} is-editing">${inlineEditor(key, label)}</div>`;
    return `<div class="home-field-group home-field-group-${key}${referenceOnly(records) ? ' has-reference' : ''}">${valueControl(key, label, records, 'home-compact-field', summary(key, fallback), `<span class="home-field-label">${icon(fieldSymbols[key] || profileFields.get(key)?.icon || 'file', 15)}${esc(label)}</span>`)}${singleReferenceConfirm(key, label, records)}${detailControl(key, label, records)}${referenceDetails(key, label, records)}</div>`;
  };
  const optionalField = (key, label) => entries(key).length || inline?.key === key ? field(key, label) : '';
  const collection = (key, label) => {
    const records = entries(key);
    if (!records.length) return `<div class="home-collection-empty">${control(`补充${esc(label)}`, 'home-add', key, 'home-inline-action', 'plus')}</div>`;
    if (referenceOnly(records)) return `<div class="home-collection home-reference-collection"><div class="home-collection-label"><span>${esc(label)}</span>${referenceBadge}${control(`<span class="sr-only">添加本人的${esc(label)}</span>`, 'home-add', key, 'home-collection-add', 'plus')}</div>${records.slice(0, 3).map(entry => `<div class="home-collection-row">${control(`<span><strong>${esc(text(entry.item?.title || entry.value, 80))}</strong></span>`, 'open-profile-record', '', 'home-collection-item', 'arrow', entry.memory.id, `查看${label}参考：${entry.item?.title || entry.value}`)}${confirmReference(entry, key, label, '确认')}</div>`).join('')}${referenceDetails(key, label, records.slice(3), { minimum: 1 })}</div>`;
    const cues = profileItemCues(records.map(entry => ({ ...entry.item, id: entry.memory.id, title: entry.item?.title || entry.value })));
    return `<div class="home-collection"><div class="home-collection-label"><span>${esc(label)}</span>${control(`<span class="sr-only">添加${esc(label)}</span>`, 'home-add', key, 'home-collection-add', 'plus')}</div>${records.slice(0, 3).map(entry => {
      const identity = profileItemDisplayName({ ...entry.item, id: entry.memory.id, title: entry.item?.title || entry.value }, cues);
      return `<div class="home-collection-row">${control(`<span><span class="home-item-identity"><strong>${esc(text(entry.item?.title || entry.value, 80))}</strong>${cues.has(entry.memory.id) ? `<span class="home-item-period">${esc(cues.get(entry.memory.id))}</span>` : ''}</span>${profileItemPhaseBadge(entry.item?.phase, 'home-item-phase')}${entry.memory.status === 'paused' ? '<span class="home-paused">AI 读取已暂停</span>' : ''}</span>`, 'home-field', key, 'home-collection-item', 'arrow', entry.memory.id, `查看${label}：${identity}`)}<button type="button" id="home-edit-item-${esc(entry.memory.id)}" class="home-collection-edit" data-action="edit-profile-item" data-id="${esc(entry.memory.id)}" aria-label="${esc(`修改${label}：${identity}`)}" title="${esc(`修改${label}：${identity}`)}">${icon('edit', 16)}</button></div>`;
    }).join('')}${records.length > 3 ? control(`查看全部 ${records.length} 项${esc(label)}`, 'home-field', key, 'home-inline-action') : ''}</div>`;
  };
  const cardHeader = (symbol, title, subtitle, key) => `<div class="home-card-heading"><span class="home-card-symbol">${icon(symbol, 24)}</span><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div>${control(`<span class="sr-only">查看${esc(title)}</span>`, 'home-section', key, 'home-card-open')}</div>`;
  const name = summary('name', '关于我');
  const displayName = entries('name').length > 1 ? '你的个人档案' : name;
  const description = summary('description', '补充一句自我介绍');
  const knownFields = new Set(all.map(entry => entry.field.key)).size;
  const recordCount = new Set(all.map(entry => entry.memory.id)).size;
  const basicKeys = ['age', 'gender', 'birthday', 'location', 'height', 'weight', 'shoeSize', 'occupation'];
  const moreKeys = ['languages', 'timezone', 'pronouns'];
  const moreKnown = moreKeys.filter(key => entries(key).length).length;
  const moreDirty = moreKeys.some(key => dirtyKeys.has(key) && !(key === 'birthday' && derivedAge));
  const preserveMore = moreDirty || moreKeys.includes(inline?.displayKey || inline?.key);
  const property = key => {
    const label = key === 'birthday' ? '生日' : key === 'pronouns' ? '称谓与代词' : profileFields.get(key)?.label || key;
    const records = entries(key);
    if ((inline?.displayKey || inline?.key) === key) return `<div class="home-property home-property-${key} is-editing">${inlineEditor(inline.key, inline.key === 'birthday' ? '生日' : profileFields.get(inline.key)?.label || label, { compact: true, displayKey: key })}</div>`;
    if (key === 'age' && derivedAge) {
      const derivedRecords = [{ memory: derivedAge.sourceMemory, reference: derivedAge.reference }];
      const value = valueControl('birthday', label, derivedRecords, 'home-property-value', derivedAge.value, `<span class="home-property-label">${esc(label)}</span><span class="home-derived-hint" title="按生日自动计算">按生日</span>${derivedAge.reference ? referenceBadge : ''}`).replace('data-value="birthday"', 'data-value="birthday" data-display-key="age"');
      return `<div class="home-property home-property-age${derivedAge.reference ? ' has-derived-reference' : ''}">${value}${detailControl('birthday', '生日与年龄', derivedRecords)}</div>`;
    }
    const confirmation = singleReferenceConfirm(key, label, records);
    return `<div class="home-property home-property-${key}${referenceOnly(records) ? ' has-reference' : ''}${confirmation ? ' has-reference-confirm' : ''}">${valueControl(key, label, records, 'home-property-value', summary(key, '选择'), `<span class="home-property-label">${esc(label)}</span>`)}${confirmation}${detailControl(key, label, records)}</div>`;
  };
  const basicReferenceChoices = keys => {
    const choices = keys.map(key => referenceDetails(key, profileFields.get(key)?.label || key, entries(key))).join('');
    return choices ? `<div class="home-basic-reference-choices">${choices}</div>` : '';
  };
  if (basicOnly) {
    const identityKeys = ['name', 'age', 'gender', 'birthday', 'location', 'height', 'weight', 'shoeSize', 'occupation', 'languages', 'timezone', 'pronouns'];
    return `<div class="profile-home profile-home-compact profile-basic-page"><section class="home-basic-sheet" aria-label="基础信息"><div class="home-property-grid">${identityKeys.filter(key => profileFields.has(key)).map(property).join('')}</div>${basicReferenceChoices(identityKeys)}<div class="home-basic-sheet-footer">${control('成长与教育', 'home-field', 'background', 'home-basic-more', 'arrow', entries('background').length === 1 ? entries('background')[0].memory.id : '', '查看成长与教育的详情')}</div></section></div>`;
  }
  const currentMemories = [...new Map(all.map(entry => [entry.memory.id, entry.memory])).values()];
  const latest = profileTimeline(currentMemories)[0];
  const lastRecordDate = latest ? new Date(latest.at).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  const miniCard = (key, label, symbol, primaryKey) => {
    const records = entries(primaryKey), single = referenceOnly(records) && records.length === 1;
    return `<section class="home-mini-card home-mini-${key}"><div class="home-mini-reference-head">${control(`<span class="home-mini-symbol">${icon(symbol, 20)}</span><span class="home-mini-copy"><span class="home-mini-label">${esc(label)}${referenceOnly(records) && !single ? referenceBadge : ''}</span><span>${esc(text(summary(primaryKey, '按需补充'), 100))}</span>${paused(records)}</span>`, single ? 'open-profile-record' : 'home-section', key, 'home-mini-open', 'arrow', single ? records[0].memory.id : '')}${singleReferenceConfirm(primaryKey, label, records)}</div>${referenceDetails(primaryKey, label, records)}</section>`;
  };
  const quickLink = (label, symbol, action, value = '') => control(`<span class="home-quick-symbol">${icon(symbol, 21)}</span><span class="home-quick-label">${esc(label)}</span>`, action, value, 'home-quick-link');
  const categoryCards = [['当前项目', 'briefcase'], ['沟通偏好', 'message'], ['生活偏好', 'heart']].map(([category, symbol]) => {
    const records = memories.filter(memory => memory.category === category && isUsableMemory(memory)
      && typeof memory.id === 'string' && !memory.id.startsWith('demo-') && memory.source?.platform?.trim() !== '演示对话')
      .sort((left, right) => (Date.parse(right.updatedAt || right.createdAt) || 0) - (Date.parse(left.updatedAt || left.createdAt) || 0)
        || left.id.localeCompare(right.id));
    if (!records.length) return '';
    return `<section class="home-data-card home-category-card" aria-label="${esc(category)}"><div class="home-card-heading"><span class="home-card-symbol">${icon(symbol, 24)}</span><div><h2>${esc(category)}</h2><p>${records.length} 条记录</p></div>${control('查看全部', 'home-category', category, 'home-inline-action', 'arrow', '', `查看全部${category}，${records.length} 条记录`)}</div><div class="home-category-records">${records.slice(0, 3).map(memory => control(`<span class="home-category-record-copy">${esc(text(memory.content, 150))}</span><span class="home-category-record-meta">${memory.confirmed === true ? '<span class="home-category-confirmed">已确认</span>' : referenceBadge}<span>来源与详情</span>${icon('arrow', 13)}</span>`, 'home-category', category, 'home-category-record', '', memory.id, `查看${category}的来源与详情：${text(memory.content, 150)}`)).join('')}</div></section>`;
  }).join('');

  return `<div class="profile-home profile-home-compact">
    <header class="home-page-heading"><div><p class="home-eyebrow">我的记忆空间</p><h1 tabindex="-1">个人主页</h1></div>${control('补充个人资料', 'home-add', '', 'home-primary-action', 'plus')}</header>
    <section class="home-character-sheet" aria-label="个人角色档案">
      <div class="home-identity-bar">
        <div class="home-compact-portrait">${portrait}</div>
        <div class="home-identity-copy"><div class="home-identity-meta"><span>角色档案</span><span>${icon('shield', 12)}${referenceEntries.length ? `含 ${referenceEntries.length} 条参考` : '本人自述'}</span></div>${inline?.key === 'name' ? inlineEditor('name', '称呼', { compact: true }) : `<div class="home-name-row"><h2 id="home-identity-name">${valueControl('name', '称呼', entries('name'), 'home-name-value', displayName)}</h2>${singleReferenceConfirm('name', '称呼', entries('name'))}${detailControl('name', '称呼', entries('name'))}</div>`}${referenceDetails('name', '称呼', entries('name'))}<div class="home-description-group">${inline?.key === 'description' ? inlineEditor('description', '自我描述') : `<div class="home-description-controls">${valueControl('description', '自我描述', entries('description'), 'home-description-value', description)}${singleReferenceConfirm('description', '自我描述', entries('description'))}${referenceOnly(entries('description')) && entries('description').length === 1 ? detailControl('description', '自我描述', entries('description')) : ''}</div>`}${referenceDetails('description', '自我描述', entries('description'))}</div></div>
        <div class="home-record-badges"><span><strong>${knownFields}</strong> 资料项</span><span><strong>${recordCount}</strong> 条记录</span></div>
      </div>
      <div class="home-basics-heading"><h2>${icon('user', 17)}基础信息</h2><span>点击选择</span>${control('完整资料', 'home-section', 'identity', 'home-basic-more')}</div>
      <div class="home-property-grid">${basicKeys.filter(key => profileFields.has(key)).map(property).join('')}</div>
      ${basicReferenceChoices(basicKeys)}
      <details class="home-more-attributes" data-key="home-more-attributes"${preserveMore ? ' data-preserve-open="true"' : ''} ${moreAttributesOpen || preserveMore ? 'open' : ''}><summary><span>更多属性</span><span class="home-more-label">${moreKnown ? `已记录 ${moreKnown} 项` : '语言 · 时区 · 称谓'}</span>${moreDirty ? '<span class="home-draft-badge">草稿</span>' : ''}${icon('down', 14)}</summary><div class="home-property-grid home-more-property-grid">${moreKeys.filter(key => profileFields.has(key)).map(property).join('')}</div>${basicReferenceChoices(moreKeys)}</details>
    </section>
    <nav class="home-quick-nav" aria-label="个人档案导航">${quickLink('基础资料', 'user', 'home-section', 'identity')}${quickLink('档案总览', 'notebook', 'home-section')}${quickLink('变迁记录', 'route', 'home-timeline')}</nav>
    <div class="home-main-content">
        ${categoryCards ? `<div class="home-category-grid">${categoryCards}</div>` : ''}
        <div class="home-dashboard-grid">
          <section class="home-data-card home-career-card">${cardHeader('briefcase', '事业与投入', '工作 · 副业', 'roles')}${collection('sidework', '副业')}${field('role', '承担的角色')}${optionalField('workstyle', '工作方式')}</section>
          <section class="home-data-card home-interest-card">${cardHeader('heart', '兴趣与能力', '爱好 · 技能', 'interests')}${collection('hobbies', '爱好')}${field('skills', '技能与擅长')}${optionalField('learningstyle', '学习方式')}</section>
          <section class="home-data-card home-personality-card">${cardHeader('spark', '性格与自述', '本人自述', 'personality')}<div class="home-personality-facts">${field('mbti', 'MBTI')}${field('attachment', '依恋模式')}</div>${field('traits', '性格特质')}</section>
          <section class="home-data-card home-direction-card">${cardHeader('target', '此刻的方向', '目标 · 阶段', 'goals')}${field('goal', '当前目标')}<div class="home-direction-details">${field('lifestage', '人生阶段')}${field('motivation', '动力来源')}</div>${optionalField('longterm', '长期方向')}${optionalField('constraints', '现实约束')}</section>
        </div>
        <section class="home-data-card home-daily-card">${cardHeader('compass', '日常与使用需求', '作息 · 饮食 · 活动 · 使用需求', 'daily')}<div class="home-daily-fields">${optionalField('routine', '作息习惯')}${optionalField('diet', '饮食偏好')}${optionalField('activity', '活动习惯')}${optionalField('accessibility', '使用需求') || ''}</div>${all.some(entry => entry.field.section === 'daily') ? '' : '<p class="home-daily-empty">作息、饮食、运动与使用需求，按需补充。</p>'}${control('补充日常资料', 'home-section', 'daily', 'home-inline-action', 'plus')}</section>
    </div>
    <div class="home-deeper-grid">${miniCard('values', '价值观与边界', 'shield', 'values')}${miniCard('relationships', '关系与支持', 'link', 'support')}${miniCard('story', '人生经历', 'route', 'milestone')}</div>
    <section class="home-history-strip"><span class="home-history-icon">${icon('route', 24)}</span><div><h2>变迁记录</h2><p>${latest ? `${esc(lastRecordDate)} · ${esc(latest.label)}` : '尚无记录'}</p></div>${control('查看变迁记录', 'home-timeline', '', 'home-history-link')}</section>
  </div>`;
}
