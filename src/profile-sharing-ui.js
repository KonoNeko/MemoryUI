import { icon } from './icons.js';
import { CATEGORIES } from './memory-taxonomy.mjs';

export const PROFILE_SHARING_DEFAULT_CATEGORIES = Object.freeze(['关于我', '沟通偏好']);
export const PROFILE_SHARING_CLIENTS = Object.freeze([
  Object.freeze({ id: 'chatgpt', name: 'ChatGPT', icon: 'message' }),
  Object.freeze({ id: 'workbuddy', name: 'WorkBuddy', icon: 'briefcase' }),
  Object.freeze({ id: 'codex', name: 'Codex', icon: 'compass' }),
  Object.freeze({ id: 'claude-code', name: 'Claude Code', icon: 'spark' }),
]);

const labels = { 关于我: '个人资料', 沟通偏好: '沟通偏好', 当前项目: '当前项目', 生活偏好: '生活偏好' };
const symbols = { 关于我: 'user', 沟通偏好: 'message', 当前项目: 'briefcase', 生活偏好: 'heart' };
const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const categories = value => Array.isArray(value) ? CATEGORIES.filter(category => value.includes(category)) : [];
const sameCategories = (left, right) => left.length === right.length && left.every(category => right.includes(category));
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const badge = (label, tone = 'neutral') => `<span class="profile-share-badge is-${tone}">${esc(label)}</span>`;
const timestamp = value => {
  const date = typeof value === 'string' && value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? `<time datetime="${esc(date.toISOString())}">${esc(date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }))}</time>`
    : '';
};
const action = (client, name, label, { primary = false, danger = false, disabled = false, symbol = '' } = {}) => `<button type="button" class="profile-share-button${primary ? ' is-primary' : ''}${danger ? ' is-danger' : ''}" data-action="profile-share-${name}" data-client="${esc(client)}"${disabled ? ' disabled' : ''}>${symbol ? icon(symbol, 15) : ''}${esc(label)}</button>`;

/**
 * Pure owner-facing renderer. The caller owns fetching, drafts and mutations.
 * policy is the saved connection.profileSharing (or null), never the draft.
 * preview is previewProfileSharing's response plus owner-derived `memories`.
 * lastRead must come from a real read audit, shaped { client?, at, count? }.
 * A preview token is required before enabling or changing the saved scope.
 */
export function renderProfileSharing({
  client = 'codex', policy = null, masterEnabled = true, selectedCategories, preview = null,
  lastRead = null, loading = false, saving = false, dirty = false,
  error = '', notice = '', previewOpen = false,
} = {}) {
  const selectedClient = PROFILE_SHARING_CLIENTS.find(candidate => candidate.id === client) || PROFILE_SHARING_CLIENTS[0];
  const clientId = selectedClient.id;
  const id = `profile-share-${clientId}`;
  const savedPolicy = policy && typeof policy === 'object' ? policy : null;
  const selected = categories(selectedCategories ?? savedPolicy?.categories ?? preview?.profileSharing?.categories ?? PROFILE_SHARING_DEFAULT_CATEGORIES);
  const masterPaused = savedPolicy?.enabled === true && masterEnabled !== true;
  const active = savedPolicy?.enabled === true && masterEnabled === true;
  const changed = dirty || Boolean(savedPolicy && !sameCategories(selected, categories(savedPolicy.categories)));
  const previewMatches = preview && preview.client === clientId
    && sameCategories(selected, categories(preview.profileSharing?.categories));
  const validPreview = Boolean(previewMatches && count(preview.count) !== null && typeof preview.previewToken === 'string' && preview.previewToken);
  const canSave = validPreview && selected.length > 0 && !loading && !saving;
  const memories = validPreview && Array.isArray(preview.memories) ? preview.memories.filter(memory => memory && typeof memory === 'object') : [];
  const visibleMemories = memories.slice(0, 8);
  const scopeCount = validPreview ? preview.count : null;
  const actualRead = lastRead && (!lastRead.client || lastRead.client === clientId) && timestamp(lastRead.at) ? lastRead : null;
  const status = loading && !savedPolicy ? badge('加载中', 'pending') : savedPolicy ? badge(masterPaused ? '读取总开关已暂停，主题设置仍保留' : active ? '主题授权已启用' : '主题授权已暂停', active ? 'active' : 'paused') : badge('主题授权未启用');
  const selection = CATEGORIES.map((category, index) => `<label class="profile-share-topic${selected.includes(category) ? ' is-selected' : ''}"><input id="${id}-category-${index}" type="checkbox" name="profileShareCategory" data-field-profile-share="category" data-client="${esc(clientId)}" value="${esc(category)}"${selected.includes(category) ? ' checked' : ''}${saving ? ' disabled' : ''}>${icon(symbols[category], 16)}<span>${esc(labels[category])}</span></label>`).join('');
  const previewContent = loading
    ? '<p class="profile-share-empty">正在获取当前范围…</p>'
    : !validPreview
      ? `<p class="profile-share-empty">${error ? '暂时无法核对当前范围。' : '当前范围尚未加载。'}</p>${action(clientId, 'retry', '重新加载范围', { disabled: saving, symbol: 'refresh' })}`
      : scopeCount === 0
        ? '<p class="profile-share-empty">当前没有可共享条目。启用后，所选主题的新记忆也会纳入范围。</p>'
        : `${visibleMemories.length ? `<ul class="profile-share-memory-list">${visibleMemories.map(memory => `<li><div class="profile-share-memory-meta">${badge(labels[memory.category] || memory.category || '记忆')}${badge(memory.confirmed === true ? '已确认' : '未核实参考', memory.confirmed === true ? 'active' : 'reference')}</div><p>${esc(memory.content)}</p></li>`).join('')}</ul>` : '<p class="profile-share-empty">条目数量已核对，打开其他授权可查看内容。</p>'}${scopeCount > visibleMemories.length ? `<p class="profile-share-preview-note">此处显示 ${visibleMemories.length} 条，共 ${scopeCount} 条。</p>` : ''}`;
  const primaryName = savedPolicy && !active && !changed ? 'resume' : 'save';
  const primaryLabel = saving ? '保存中…' : !savedPolicy ? '启用这组主题' : !active ? changed ? '保存并恢复这组主题' : '恢复这组主题' : '保存更改';

  return `<section class="profile-sharing" aria-labelledby="${id}-title" aria-busy="${loading || saving}">
    <header class="profile-share-heading"><span class="profile-share-heading-icon">${icon('user', 23)}</span><div><h2 id="${id}-title">让 AI 使用个人档案</h2><p>选好主题后，授权一次即可。</p></div></header>
    <div class="profile-share-clients" role="group" aria-label="选择使用个人档案的 AI">${PROFILE_SHARING_CLIENTS.map(candidate => `<button type="button" class="profile-share-client${candidate.id === clientId ? ' is-selected' : ''}" data-action="profile-share-client" data-value="${candidate.id}" aria-pressed="${candidate.id === clientId}"${saving ? ' disabled' : ''}>${icon(candidate.icon, 17)}${candidate.name}</button>`).join('')}</div>
    <div class="profile-share-status" role="status" aria-live="polite" aria-atomic="true">${status}${changed ? badge('有未保存更改', 'pending') : savedPolicy ? '<span>设置已保存</span>' : '<span>保存后才会生效</span>'}</div>
    <fieldset class="profile-share-topics"><legend>${esc(selectedClient.name)} 可以使用哪些主题</legend><div>${selection}</div></fieldset>
    <p id="${id}-scope-help" class="profile-share-scope-help">启用后，${esc(selectedClient.name)} 可读取所选主题中现有和以后新增的记忆。单条排除仍保留，未核实参考会保留标记。</p>
    ${selected.length ? '' : '<p class="profile-share-validation">请至少选择一个主题。</p>'}
    <details class="profile-share-preview" data-key="${id}-preview"${previewOpen ? ' open' : ''}><summary><span>${icon('notebook', 16)}查看当前范围</span>${badge(loading ? '加载中' : scopeCount === null ? '待加载' : `${scopeCount} 条`, loading || scopeCount === null ? 'pending' : 'neutral')}${icon('down', 14)}</summary><div class="profile-share-preview-body">${validPreview && (count(preview.confirmedCount) !== null || count(preview.referenceCount) !== null) ? `<p class="profile-share-preview-counts">${count(preview.confirmedCount) !== null ? `已确认 ${preview.confirmedCount} 条` : ''}${count(preview.confirmedCount) !== null && count(preview.referenceCount) !== null ? ' · ' : ''}${count(preview.referenceCount) !== null ? `未核实参考 ${preview.referenceCount} 条` : ''}</p>` : ''}${previewContent}</div></details>
    ${error ? `<p class="profile-share-feedback is-error" role="alert">${icon('info', 16)}<span>${esc(error)}</span></p>` : notice ? `<p class="profile-share-feedback" role="status">${icon('check', 16)}<span>${esc(notice)}</span></p>` : ''}
    <div class="profile-share-actions">${action(clientId, primaryName, primaryLabel, { primary: true, disabled: !canSave || Boolean(active && !changed), symbol: 'check' })}${active ? action(clientId, 'pause', '暂停这组主题', { disabled: saving, symbol: 'pause' }) : ''}${savedPolicy ? action(clientId, 'revoke', '撤回这组主题', { danger: true, disabled: saving }) : ''}</div>
    <p class="profile-share-other-help">已暂停的原授权不会因启用主题而恢复。暂停或撤回这组主题后，其他授权仍可能允许读取（仅限原已开启的范围）。</p>
    <div class="profile-share-audit"><span class="profile-share-audit-icon">${icon('clock', 17)}</span><div><strong>最近实际读取</strong>${actualRead ? `<p>${timestamp(actualRead.at)}${count(actualRead.count) !== null ? ` · 返回 ${actualRead.count} 条` : ''}</p><p>这是服务读取记录，不代表 AI 已在回答中采用。</p>${masterPaused ? '<p>历史读取不代表当前可读。</p>' : ''}` : '<p>暂无此 AI 的读取记录。保存授权不代表 AI 已读取。</p>'}</div></div>
    <div class="profile-share-details-link">${action(clientId, 'details', '查看其他授权与单条排除', { disabled: saving, symbol: 'arrow' })}</div>
  </section>`;
}
