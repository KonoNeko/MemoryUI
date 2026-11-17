import { icon } from './icons.js';
import { PROFILE_FIELDS } from './profile-model.js';

export const ONBOARDING_SOURCES = Object.freeze([
  { id: 'current_conversation', label: '本次对话', icon: 'message', hint: '当前可见的本人信息' },
  { id: 'codex_memory', label: 'Codex 记忆', icon: 'notebook', hint: '本机已保存的资料' },
  { id: 'codex_history', label: '历史对话', icon: 'clock', hint: '从本人陈述中查找资料' },
]);
export const ONBOARDING_CATEGORIES = Object.freeze(['关于我', '沟通偏好', '当前项目', '生活偏好']);
const sourceIds = ONBOARDING_SOURCES.map(source => source.id);
const categoryIcons = ['user', 'message', 'briefcase', 'heart'];
const fieldLabels = new Map([...PROFILE_FIELDS.map(field => [field.key, field.label]), ['communication', '沟通偏好']]);
const esc = (value = '') => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const unique = (values, allowed) => Array.isArray(values) ? [...new Set(values.filter(value => allowed.includes(value)))] : [];
const safeFields = values => unique(values, [...fieldLabels.keys()]);
const historyScope = value => ({ days: Number.isInteger(value?.days) && value.days >= 1 && value.days <= 365 ? value.days : null,
  workspace: value?.workspace === 'all' ? 'all' : typeof value?.workspace === 'string' && value.workspace ? 'current' : null });
function sourceCoverageOf(job) {
  const raw = job?.sourceCoverage ?? job?.report ?? {};
  const keys = { native: ['discoveredFiles', 'readFiles', 'skippedFiles', 'truncatedFiles', 'leftoverFiles'], history: ['discoveredThreads', 'readThreads', 'leftoverThreads', 'leftoverTurns'], current: ['readTurns', 'readMessages', 'leftoverTurns'] };
  const coverage = Object.fromEntries(Object.entries(keys).map(([kind, names]) => [kind, Object.fromEntries(names.map(name => [name, count(raw[kind]?.[name])]))]));
  return { ...coverage, limited: job?.limited === true || raw.limited === true || count(raw.skippedSources) > 0 || count(raw.truncatedSources) > 0
    || ['skippedFiles', 'truncatedFiles', 'leftoverFiles'].some(key => coverage.native[key] > 0)
    || coverage.history.leftoverThreads > 0 || coverage.history.leftoverTurns > 0 || coverage.current.leftoverTurns > 0 };
}
const jobStates = ['queued', 'running', 'attention', 'completed', 'failed', 'expired'];
const clone = value => structuredClone(value);
const defaults = () => ({ sources: ['codex_memory', 'codex_history'], categories: ['关于我', '沟通偏好'], history: { days: 90, workspace: 'all' }, autoCapture: true, readNew: true });
const cleanCounts = value => {
  const keys = ['total', 'confirmed', 'references', 'created', 'updated', 'unchanged'];
  if (!value || keys.some(key => count(value[key]) === null)
    || value.confirmed + value.references !== value.total || value.created + value.updated + value.unchanged !== value.total) return null;
  return Object.fromEntries(keys.map(key => [key, value[key]]));
};
const needsHost = report => report?.current?.state === 'needs_host_context' || report?.current?.status === 'needs_host_context'
  || report?.current?.needsHostContext === true || (Array.isArray(report?.current?.issues) && report.current.issues.some(issue => issue === 'needs_host_context' || issue?.reason === 'needs_host_context'));

/** Whitelist counts and states only: never retain source bodies, paths or raw model output. */
export function normalizeOnboardingStatus(value) {
  if (!value || typeof value !== 'object' || !['configured', 'grant', 'job', 'latestJob', 'jobs', 'sources', 'autoCapture'].some(key => Object.hasOwn(value, key))) throw new TypeError('Missing onboarding status.');
  const rawJob = value.job ?? value.latestJob ?? (Array.isArray(value.jobs) ? value.jobs[0] : null);
  const job = rawJob && jobStates.includes(rawJob.status) ? {
    id: typeof rawJob.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(rawJob.id) ? rawJob.id : null,
    status: rawJob.status,
    stage: ['queued', 'running', 'reading', 'extracting', 'saving', 'attention', 'completed', 'failed', 'expired'].includes(rawJob.stage) ? rawJob.stage : rawJob.status,
    progress: typeof rawJob.progress === 'number' && Number.isFinite(rawJob.progress) && rawJob.progress >= 0 && rawJob.progress <= 100 ? rawJob.progress : null,
    counts: cleanCounts(rawJob.counts), sourceCount: count(rawJob.sourceCount), batchCount: count(rawJob.batchCount),
    sourceCoverage: sourceCoverageOf(rawJob), limited: sourceCoverageOf(rawJob).limited,
    sources: unique(rawJob.sources, sourceIds), categories: unique(rawJob.categories, ONBOARDING_CATEGORIES), history: historyScope(rawJob.history),
    fieldCoverage: { found: safeFields(Array.isArray(rawJob.fieldCoverage) ? rawJob.fieldCoverage : rawJob.fieldCoverage?.found), missing: safeFields(rawJob.missingFields ?? rawJob.fieldCoverage?.missing) },
    needsHostContext: rawJob.needsHostContext === true || needsHost(rawJob.report),
  } : null;
  const rawAuto = value.autoCapture || {};
  return {
    configured: value.configured === true || value.grant?.approved === true,
    grant: { approved: value.grant?.approved === true, categories: unique(value.grant?.categories, ONBOARDING_CATEGORIES), sources: unique(value.grant?.sources, sourceIds), history: historyScope(value.grant?.history),
      futureCurrent: typeof value.grant?.future_current === 'boolean' ? value.grant.future_current : typeof value.grant?.futureCurrent === 'boolean' ? value.grant.futureCurrent : null,
      readNew: typeof value.grant?.readNew === 'boolean' ? value.grant.readNew : null },
    sources: ONBOARDING_SOURCES.map(source => {
      const raw = Array.isArray(value.sources) && value.sources.find(item => item?.id === source.id);
      return { id: source.id, available: raw?.available === true, state: ['ready', 'needs_host', 'unavailable'].includes(raw?.state) ? raw.state : 'unknown' };
    }),
    job,
    autoCapture: { enabled: rawAuto.enabled === true, pendingCount: count(rawAuto.pendingCount), processing: rawAuto.processing === true,
      hookState: ['not_checked', 'needs_trust', 'trusted', 'unavailable', 'disabled'].includes(rawAuto.hookState) ? rawAuto.hookState : 'not_checked' },
  };
}

function jobPanel(job) {
  if (!job) return '';
  const active = ['queued', 'running'].includes(job.status), completed = job.status === 'completed';
  const title = ({ queued: '已排队，准备查找资料', running: '正在自动整理个人档案', attention: '部分步骤需要处理', completed: job.limited ? '本批个人档案已整理' : '个人档案已整理', failed: '本次整理未完成', expired: '本次整理任务已过期' })[job.status];
  const found = job.fieldCoverage.found, missing = job.fieldCoverage.missing;
  const hasReceipt = ['completed', 'attention'].includes(job.status) && job.counts;
  const coverage = job.sourceCoverage;
  const read = [coverage.native.readFiles !== null ? `Codex 记忆 ${coverage.native.readFiles} 个文件` : '', coverage.history.readThreads !== null ? `历史对话 ${coverage.history.readThreads} 个` : '', coverage.current.readTurns !== null ? `本次对话 ${coverage.current.readTurns} 轮` : coverage.current.readMessages !== null ? `本次对话 ${coverage.current.readMessages} 条消息` : ''].filter(Boolean);
  const leftover = [coverage.history.leftoverThreads > 0 ? `${coverage.history.leftoverThreads} 个历史对话` : '', coverage.history.leftoverTurns > 0 ? `${coverage.history.leftoverTurns} 轮历史对话` : '', coverage.current.leftoverTurns > 0 ? `${coverage.current.leftoverTurns} 轮本次对话` : ''].filter(Boolean);
  return `<section class="onboarding-job is-${job.status}" aria-labelledby="onboarding-job-title"><div class="onboarding-job-heading"><span>${icon(completed ? 'check' : active ? 'refresh' : 'info', 20)}</span><div><h3 id="onboarding-job-title" tabindex="-1">${title}</h3><p>${active ? '按授权范围查找证据、归类并保存，无需逐项填写。' : completed ? job.counts?.total === 0 ? '未找到符合范围的资料，缺少的信息继续留空。' : '可以直接在个人主页查看、修改；参考资料保留标记。' : '已有资料保持原样，完成的保存结果以回执为准。'}</p></div></div>
    ${active ? `<progress aria-label="个人档案自动整理进度"${job.progress === null ? '' : ` max="100" value="${job.progress}"`}></progress>${job.progress === null ? '' : `<span class="onboarding-progress-label">${job.progress}%</span>`}` : ''}
    ${hasReceipt ? `<div class="onboarding-receipt"><span><strong>${job.counts.created}</strong> 新增</span><span><strong>${job.counts.references}</strong> 参考</span><span><strong>${job.counts.unchanged}</strong> 不重复</span></div>` : ''}
    ${read.length || job.limited ? `<p class="onboarding-source-coverage${job.limited ? ' is-limited' : ''}">${icon(job.limited ? 'info' : 'notebook',15)}<span>${read.length ? `本批读取 ${read.join(' · ')}。` : ''}${leftover.length ? `仍有 ${leftover.join('、')}未纳入本批。` : job.limited ? '部分来源未完整纳入本批。' : ''}</span></p>` : ''}
    ${found.length ? `<p class="onboarding-coverage">已找到 ${found.length} 项资料依据：${found.slice(0, 4).map(key => esc(fieldLabels.get(key))).join('、')}${found.length > 4 ? '等' : ''}。</p>` : ''}
    ${missing.length && !active ? `<p class="onboarding-missing">${missing.slice(0, 4).map(key => esc(fieldLabels.get(key))).join('、')}${missing.length > 4 ? '等' : ''}暂无依据，已留空；之后随时补充。</p>` : ''}
    ${job.needsHostContext ? `<p class="onboarding-feedback is-warning">${icon('message', 16)}本次对话尚需当前 Codex 提供可见上下文；不会改读其他对话。</p>` : ''}
    <div class="onboarding-job-actions">${completed ? '<button type="button" class="onboarding-button is-primary" data-action="navigate" data-value="home">查看个人档案</button>' : ''}<button type="button" id="onboarding-refresh" class="onboarding-button" data-action="onboarding-refresh">${icon('refresh', 15)}刷新进度</button></div>
  </section>`;
}

/** Sources and scope stay editable locally until the explicit authorize action. */
export function renderOnboardingCard({ status = null, selection = defaults(), loading = false, saving = false, dirty = false, error = '', notice = '', advancedOpen = false, sourcesOpen = false, hasCurrentWorkspace = false } = {}) {
  let data = null;
  try { if (status) data = normalizeOnboardingStatus(status); } catch { error = true; }
  const current = { ...defaults(), ...selection, history: { ...defaults().history, ...selection?.history } };
  current.sources = unique(current.sources, sourceIds); current.categories = unique(current.categories, ONBOARDING_CATEGORIES);
  const job = data?.job, active = ['queued', 'running'].includes(job?.status), done = job?.status === 'completed';
  if (active) {
    if (job.sources.length) current.sources = [...job.sources];
    if (job.categories.length) current.categories = [...job.categories];
    if (job.history.days !== null) current.history.days = job.history.days;
    if (job.history.workspace !== null) current.history.workspace = job.history.workspace;
  }
  const step = active ? 2 : done ? 3 : 1;
  const disabled = saving || active;
  const selectionForm = `<div class="onboarding-selection"><fieldset class="onboarding-sources"><legend>允许从哪里查找？</legend><div>${ONBOARDING_SOURCES.map(source => {
    const state = data?.sources.find(item => item.id === source.id)?.state;
    return `<label class="onboarding-source${current.sources.includes(source.id) ? ' is-selected' : ''}"><input type="checkbox" id="onboarding-source-${source.id}" name="onboardingSource" value="${source.id}"${current.sources.includes(source.id) ? ' checked' : ''}${disabled ? ' disabled' : ''}>${icon(source.icon, 21)}<span><strong>${source.label}</strong><small>${source.hint}</small>${state === 'needs_host' ? '<em>需当前 Codex 提供</em>' : state === 'unavailable' ? '<em>暂未发现资料</em>' : ''}</span></label>`;
  }).join('')}</div></fieldset>
    ${current.sources.includes('codex_history') ? `<div class="onboarding-history"><label for="onboarding-history-days">历史范围</label><select id="onboarding-history-days" name="onboardingHistoryDays"${disabled ? ' disabled' : ''}>${[...new Set([30, 90, 365, current.history.days])].filter(days=>Number.isInteger(days)&&days>=1&&days<=365).sort((a,b)=>a-b).map(days => `<option value="${days}"${current.history.days === days ? ' selected' : ''}>最近 ${days} 天${days === 90 ? ' · 建议' : ''}</option>`).join('')}</select>${hasCurrentWorkspace && !active ? `<label class="onboarding-workspace-label" for="onboarding-workspace">工作区</label><select id="onboarding-workspace" name="onboardingWorkspace"${disabled ? ' disabled' : ''}><option value="all"${current.history.workspace !== 'current' ? ' selected' : ''}>全部工作区</option><option value="current"${current.history.workspace === 'current' ? ' selected' : ''}>所选工作区</option></select>` : `<span>${current.history.workspace === 'current' ? '指定工作区' : '全部工作区'}</span>`}</div>` : ''}
    <fieldset class="onboarding-topics"><legend>优先整理哪些主题？</legend><div>${ONBOARDING_CATEGORIES.map((category, index) => `<label><input type="checkbox" id="onboarding-category-${index}" name="onboardingCategory" value="${category}"${current.categories.includes(category) ? ' checked' : ''}${disabled ? ' disabled' : ''}>${icon(categoryIcons[index], 16)}${category}</label>`).join('')}</div></fieldset>
    <details class="onboarding-advanced" data-key="onboarding-advanced"${advancedOpen ? ' open' : ''}><summary><span>${icon('shield', 16)}后续自动记忆与读取</span>${icon('down', 14)}</summary><div><label class="onboarding-switch"><span><strong>后续对话自动记录</strong><small>仅使用已授权、宿主实际提供的对话。</small></span><input id="onboarding-auto-capture" type="checkbox" name="onboardingAutoCapture"${current.autoCapture ? ' checked' : ''}${disabled ? ' disabled' : ''}></label><label class="onboarding-switch"><span><strong>让 Codex 使用新档案</strong><small>仅限本次勾选主题；保留单条排除。</small></span><input id="onboarding-read-new" type="checkbox" name="onboardingReadNew"${current.readNew ? ' checked' : ''}${disabled ? ' disabled' : ''}></label></div></details>
    ${!current.sources.length || !current.categories.length ? '<p class="onboarding-feedback is-error" role="alert">至少选择一个来源和一个主题。</p>' : ''}
    <p class="onboarding-consent">${icon('shield', 15)}点击即授权读取所选资料并整理保存。${current.autoCapture ? '后续对话自动记录' : '后续自动记录关闭'} · ${current.readNew ? 'Codex 可读取所选主题的新档案' : '新档案先仅自己可见'}。</p><p class="onboarding-runtime">${icon('compass', 15)}需本机 Codex 已登录；整理会使用当前账号的模型额度。</p><div class="onboarding-actions"><button type="button" id="onboarding-start" class="onboarding-button is-primary" data-action="onboarding-start"${disabled || !current.sources.length || !current.categories.length ? ' disabled' : ''}>${icon(saving ? 'clock' : 'spark', 17)}${saving ? '正在启动…' : '授权并整理个人档案'}</button>${dirty ? '<span class="onboarding-dirty">范围尚未提交</span>' : ''}</div></div>`;
  const auto = data?.autoCapture;
  const autoLabel = !data?.configured ? '' : !auto?.enabled ? '后续自动记录未开启' : auto.processing ? '正在整理新的对话' : auto.hookState === 'needs_trust' ? '自动记录还需在 Codex 信任本机 Hook' : auto.hookState === 'trusted' ? '本机采集 Hook 已信任' : '后续自动记录待宿主检查';
  return `<section class="onboarding-card" aria-labelledby="onboarding-title" aria-busy="${loading || saving}"><header class="onboarding-heading"><span>${icon('user', 27)}</span><div><h2 id="onboarding-title">先让 Codex 认识你</h2><p>先问 Codex，未找到的留空；之后随时补充。</p></div><span class="onboarding-local">本机授权</span></header><ol class="onboarding-steps" aria-label="个人档案建立流程">${[['shield','选择资料'],['spark','自动整理'],['edit','随时修改']].map(([symbol,label],index)=>`<li${step === index+1 ? ' aria-current="step"' : ''}><span>${icon(symbol,19)}</span><strong>${index+1}. ${label}</strong></li>`).join('')}</ol>
    ${jobPanel(job)}${job && (active || done) ? `<details class="onboarding-source-settings" data-key="onboarding-sources"${sourcesOpen ? ' open' : ''}><summary><span>${active ? '查看本次授权范围' : '调整范围或重新整理'}</span>${icon('down',14)}</summary>${selectionForm}</details>` : selectionForm}
    ${error ? `<p class="onboarding-feedback is-error" role="alert">${icon('info', 16)}自动整理暂未完成，请先刷新状态再试。已有资料不受影响。</p>${!job ? `<button type="button" id="onboarding-refresh" class="onboarding-button" data-action="onboarding-refresh"${loading ? ' disabled' : ''}>${icon('refresh',15)}刷新状态</button>` : ''}` : notice ? `<p class="onboarding-feedback" role="status">${icon('check',16)}${notice === 'started' ? '整理任务已提交，进度会在这里更新。' : notice === 'running' ? '已有任务正在整理，请等待当前任务完成。' : '状态已更新。'}</p>` : ''}
    ${autoLabel ? `<p class="onboarding-auto-state">${icon(auto?.hookState === 'trusted' ? 'check' : 'info',15)}${autoLabel}${count(auto?.pendingCount) > 0 ? ` · ${auto.pendingCount} 段对话待整理` : ''}</p>` : ''}<p class="onboarding-boundary">只使用已授权的本机来源；不读取云端隐藏记忆，也不把未知信息猜成事实。</p></section>`;
}

/** Calls are inert until load or the explicit start action; polling belongs to the host UI. */
export function createOnboardingController({ request, onChange = () => {}, currentThreadId, currentWorkspace } = {}) {
  if (typeof request !== 'function') throw new TypeError('Onboarding requires request.');
  let state = { status: null, selection: defaults(), loading: false, saving: false, dirty: false, error: '', notice: '', hasCurrentWorkspace: typeof currentWorkspace === 'string' && !!currentWorkspace };
  let workspaceBinding = currentWorkspace;
  let inFlight = null, version = 0, configuredSelections = false, mutationEpoch = 0, readSerial = 0;
  const getState = () => clone(state), notify = () => onChange(getState());
  const setSelection = (name, value, checked) => {
    if (state.saving || ['queued', 'running'].includes(state.status?.job?.status)) return false;
    const next = clone(state.selection);
    if (name === 'onboardingSource' && sourceIds.includes(value)) next.sources = checked ? unique([...next.sources, value], sourceIds) : next.sources.filter(id => id !== value);
    else if (name === 'onboardingCategory' && ONBOARDING_CATEGORIES.includes(value)) next.categories = checked ? unique([...next.categories, value], ONBOARDING_CATEGORIES) : next.categories.filter(category => category !== value);
    else if (name === 'sources' && Array.isArray(value)) next.sources = unique(value, sourceIds);
    else if (name === 'categories' && Array.isArray(value)) next.categories = unique(value, ONBOARDING_CATEGORIES);
    else if (name === 'onboardingHistoryDays' && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 365) next.history.days = Number(value);
    else if (name === 'onboardingWorkspace' && (value === 'all' || value === 'current' && state.hasCurrentWorkspace)) next.history.workspace = value;
    else if (name === 'onboardingAutoCapture' && typeof value === 'boolean') next.autoCapture = value;
    else if (name === 'onboardingReadNew' && typeof value === 'boolean') next.readNew = value;
    else return false;
    state.selection = next; state.dirty = true; state.error = ''; state.notice = ''; ++version; notify(); return true;
  };
  async function load() {
    if (state.saving) return false;
    if (inFlight) return inFlight;
    const ownVersion = version, ownEpoch = mutationEpoch, ownRead = ++readSerial;
    const current = () => ownEpoch === mutationEpoch && ownRead === readSerial;
    state.loading = true;
    inFlight = Promise.resolve().then(async () => {
      try {
        const raw = await request('/api/onboarding/status?client=codex');
        const data = normalizeOnboardingStatus(raw);
        if (!current()) return false;
        state.status = data; state.error = '';
        if (!configuredSelections && !state.dirty && ownVersion === version && data.configured) {
          if (data.grant.categories.length) state.selection.categories = [...data.grant.categories];
          if (data.grant.sources.length) state.selection.sources = [...data.grant.sources];
          if (data.grant.history.days !== null) state.selection.history.days = data.grant.history.days;
          if (data.grant.history.workspace === 'all') state.selection.history.workspace = 'all';
          else if (data.grant.history.workspace === 'current' && typeof raw.grant?.history?.workspace === 'string') {
            workspaceBinding = raw.grant.history.workspace; state.hasCurrentWorkspace = true; state.selection.history.workspace = 'current';
          }
          if (typeof data.grant.futureCurrent === 'boolean') state.selection.autoCapture = data.grant.futureCurrent;
          if (typeof data.grant.readNew === 'boolean') state.selection.readNew = data.grant.readNew;
          configuredSelections = true;
        }
        return true;
      } catch { if (current()) state.error = 'status_unavailable'; return false; }
      finally { if (current()) { state.loading = false; inFlight = null; notify(); } }
    }); notify(); return inFlight;
  }
  async function start() {
    if (state.saving) return false;
    if (['queued', 'running'].includes(state.status?.job?.status)) { state.notice = 'running'; notify(); return false; }
    if (!state.selection.sources.length || !state.selection.categories.length) { state.error = 'selection_required'; notify(); return false; }
    const payload = { client: 'codex', ...clone(state.selection), consent: true };
    if (payload.history.workspace === 'current') payload.history.workspace = workspaceBinding;
    if (payload.sources.includes('current_conversation') && typeof currentThreadId === 'string' && currentThreadId) payload.currentThreadId = currentThreadId;
    state.saving = true; state.loading = false; inFlight = null; state.error = ''; state.notice = ''; ++version; ++mutationEpoch; ++readSerial; notify();
    try {
      const response = await request('/api/onboarding/start', payload);
      const normalized = normalizeOnboardingStatus({ ...state.status, ...response, job: response.job });
      if (!normalized.job?.id) throw new Error('Missing job receipt.');
      state.status = normalized; state.dirty = false; state.notice = 'started'; return true;
    } catch { state.error = 'start_unavailable'; return false; }
    finally { state.saving = false; notify(); }
  }
  return { getState, load, start, setSelection, update: setSelection, handleAction: name => name === 'onboarding-start' ? start() : name === 'onboarding-refresh' ? load() : Promise.resolve(false) };
}
