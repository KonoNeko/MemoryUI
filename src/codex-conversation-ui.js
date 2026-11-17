import { icon } from './icons.js';

const esc = (value = '') => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const identifier = value => typeof value === 'string' && value.trim() && value.length <= 200 ? value.trim() : null;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const dateLabel = value => value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '尚无同步回执';

function normalizeSubscription(value) {
  if (!value || !identifier(value.threadId) || typeof value.enabled !== 'boolean') return null;
  return {
    threadId: value.threadId, projectId: identifier(value.projectId), enabled: value.enabled,
    automatic: value.automatic === true, permissionPaused: value.permissionPaused === true,
    savedCount: count(value.savedCount ?? value.recordedMessages),
    skippedMessages: count(value.skippedMessages),
    lastSyncedAt: timestamp(value.lastSyncedAt ?? value.lastSyncAt),
    lastSuccessAt: timestamp(value.lastSuccessAt),
    lastError: typeof value.lastError === 'string' && value.lastError ? value.lastError.slice(0, 500)
      : typeof value.error?.message === 'string' ? value.error.message.slice(0, 500) : null,
    issueCount: Array.isArray(value.issues) ? value.issues.length : 0,
  };
}

export function normalizeCodexConversationStatus(response) {
  const recording = response?.recording ?? response;
  if (!recording || !Array.isArray(recording.subscriptions)) throw new TypeError('Invalid Codex recording status.');
  return {
    available: response.available ?? recording.available ?? null,
    running: recording.running === true,
    currentThreadId: identifier(response.currentThreadId),
    subscriptions: recording.subscriptions.map(normalizeSubscription).filter(Boolean),
  };
}

function normalizeThreads(response) {
  if (!response || !Array.isArray(response.threads)) throw new TypeError('Invalid Codex conversation metadata.');
  const seen = new Set();
  return response.threads.flatMap(value => {
    const id = identifier(value.id);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const workspace = typeof value.workspace === 'string' ? value.workspace.split(/[\\/]/).filter(Boolean).at(-1) : '';
    const projectId = identifier(value.projectId);
    return [{ id, workspace, projectId: projectId?.length <= 100 ? projectId : null,
      createdAt: timestamp(value.createdAt), updatedAt: timestamp(value.updatedAt) }];
  });
}

export function createCodexConversationController({ request, currentThreadId, onChange = () => {}, onStarted = async () => {} } = {}) {
  if (typeof request !== 'function') throw new TypeError('A request function is required.');
  const providedThreadId = identifier(currentThreadId);
  const state = {
    status: null, threads: [], selectedThreadId: providedThreadId || '', currentThreadId: providedThreadId,
    projectId: '', loading: false, working: '', loaded: false,
    error: '', notice: '', threadError: '',
  };
  let version = 0;
  let inFlight = null;
  let projectEdited = false;
  let pendingReceipt = null;
  const automaticAttempts = new Set();
  const openedCurrentContexts = new Set();
  const view = () => structuredClone(state);
  const notify = options => onChange(options);
  const chooseThread = () => {
    if (!state.selectedThreadId) {
      state.selectedThreadId = state.currentThreadId || '';
    }
    const existing = state.status?.subscriptions.find(item => item.threadId === state.selectedThreadId);
    if (!projectEdited && existing) state.projectId = existing.projectId || '';
    else if (!projectEdited) {
      const thread = state.threads.find(item => item.id === state.selectedThreadId);
      state.projectId = thread?.projectId || thread?.workspace?.slice(0, 100) || '';
    }
  };
  const applyStatus = response => {
    state.status = normalizeCodexConversationStatus(response);
    if (pendingReceipt && state.status.subscriptions.some(item => item.threadId === pendingReceipt.threadId && item.enabled === pendingReceipt.enabled)) pendingReceipt = null;
    state.currentThreadId = providedThreadId || state.status.currentThreadId || state.currentThreadId;
    chooseThread();
  };
  const load = async ({ background = false } = {}) => {
    if (state.working || inFlight) return false;
    const activeVersion = ++version;
    const previous = JSON.stringify([state.status, state.threads, state.currentThreadId, state.error, state.threadError]);
    if (!background) { state.loading = true; notify(); }
    const promise = Promise.resolve().then(async () => {
      try {
        const results = await Promise.allSettled([
          request('/api/codex-conversations/status'),
          request('/api/codex-conversations/threads'),
        ]);
        if (activeVersion !== version) return false;
        if (results[0].status === 'fulfilled') {
          applyStatus(results[0].value);
          state.error = pendingReceipt?.message || '';
          state.loaded = true;
        } else state.error = '暂时无法检查 Codex 实时记录，请刷新重试。';
        if (results[1].status === 'fulfilled') {
          state.threads = normalizeThreads(results[1].value);
          state.threadError = '';
          chooseThread();
        } else state.threadError = '近期对话列表暂不可用。';
        const current = state.currentThreadId;
        if (state.loaded && state.status.available !== false && current && state.selectedThreadId === current) {
          const existing = state.status.subscriptions.find(item => item.threadId === current);
          if (!existing && !automaticAttempts.has(current)) {
            automaticAttempts.add(current);
            await mutate('start');
          } else if (existing?.enabled && !openedCurrentContexts.has(current)) {
            openedCurrentContexts.add(current);
            try { await onStarted({ threadId: current, projectId: existing.projectId }); }
            catch { state.notice = existing.permissionPaused ? '自动授权已暂停，已保存内容可稍后刷新查看。' : '记录已启用，可刷新下方查看最新内容。'; }
          }
        }
        return true;
      } catch {
        if (activeVersion === version) state.error = 'Codex 记录状态返回不完整，请刷新重试。';
        return false;
      } finally {
        if (activeVersion === version) {
          state.loading = false;
          if (!background || previous !== JSON.stringify([state.status, state.threads, state.currentThreadId, state.error, state.threadError])) notify({ background });
        }
        if (inFlight === promise) inFlight = null;
      }
    });
    inFlight = promise;
    return promise;
  };
  const mutate = async action => {
    if (state.working) return false;
    const threadId = identifier(state.selectedThreadId);
    if (!threadId) { state.error = '请先选择需要记录的 Codex 对话。'; notify(); return false; }
    if (action === 'start' && state.projectId.trim().length > 100) {
      state.error = '项目编号最多 100 个字符。'; notify(); return false;
    }
    const projectId = state.projectId.trim();
    ++version;
    pendingReceipt = null;
    state.loading = false; state.working = action; state.error = ''; state.notice = ''; notify();
    try {
      const response = await request(`/api/codex-conversations/${action}`, action === 'start'
        ? { threadId, ...(projectId ? { projectId } : {}), consent: true }
        : { threadId });
      applyStatus(response);
      const subscription = state.status.subscriptions.find(item => item.threadId === threadId);
      if (!subscription || subscription.enabled !== (action === 'start')) throw new Error('Missing recording receipt.');
      if (action === 'start') {
        openedCurrentContexts.add(threadId);
        state.notice = '已启用这段对话的记录，完成的用户消息与助手回复会自动追加。';
        if (threadId === state.selectedThreadId) {
          try { await onStarted({ threadId, projectId: subscription.projectId }); }
          catch { state.notice = '记录已启用。可刷新下方记录查看最新内容。'; }
        }
      } else state.notice = '已停止这段对话后续的自动记录。';
      return true;
    } catch {
      state.error = action === 'start' ? '启用结果尚未确认，请刷新状态后查看回执。' : '停止结果尚未确认，请刷新状态后查看回执。';
      pendingReceipt = { threadId, enabled: action === 'start', message: state.error };
      return false;
    } finally { state.working = ''; notify(); }
  };
  return {
    view, load,
    update(name, value) {
      if (!['selectedThreadId', 'projectId'].includes(name) || state.working) return;
      state[name] = value;
      state.notice = '';
      if (name === 'selectedThreadId') {
        projectEdited = false;
        const existing = state.status?.subscriptions.find(item => item.threadId === value);
        const thread = state.threads.find(item => item.id === value);
        state.projectId = existing ? existing.projectId || '' : thread?.projectId || thread?.workspace?.slice(0, 100) || '';
      }
      if (name === 'projectId') projectEdited = true;
    },
    start: () => mutate('start'),
    stop: () => mutate('stop'),
    async viewSaved() {
      if (state.working) return false;
      const subscription = state.status?.subscriptions.find(item => item.threadId === state.selectedThreadId);
      if (!subscription) return false;
      state.working = 'view'; state.error = ''; state.notice = ''; notify();
      try {
        await onStarted({ threadId: subscription.threadId, projectId: subscription.projectId });
        state.notice = '已切换到这段 Codex 对话，可在下方查看记录并请求记忆。';
        return true;
      } catch {
        state.error = '记录读取尚未完成，请刷新后重试。';
        return false;
      } finally { state.working = ''; notify(); }
    },
  };
}

export function renderCodexConversationCard(state = {}) {
  const s = { threads: [], selectedThreadId: '', projectId: '', ...state };
  const status = s.status;
  const subscription = status?.subscriptions.find(item => item.threadId === s.selectedThreadId);
  const enabled = subscription?.enabled === true;
  const permissionPaused = enabled && subscription.permissionPaused === true;
  const active = enabled && !permissionPaused;
  const pending = !!s.working;
  const choices = [...s.threads];
  for (const id of [s.currentThreadId, ...(status?.subscriptions.map(item => item.threadId) || [])]) {
    if (id && !choices.some(item => item.id === id)) choices.unshift({ id });
  }
  const options = `${s.selectedThreadId ? '' : '<option value="" selected>选择需要记录的对话</option>'}${choices.map(item => {
    const label = item.id === s.currentThreadId ? '当前 Codex 对话'
      : `${item.workspace || '本机对话'}${item.updatedAt || item.createdAt ? ` · ${dateLabel(item.updatedAt || item.createdAt)}` : ''}`;
    return `<option value="${esc(item.id)}"${item.id === s.selectedThreadId ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('')}`;
  const unavailable = status?.available === false;
  const label = !s.loaded ? '正在发现当前对话' : permissionPaused ? '自动授权已暂停' : active ? subscription.lastError ? '已自动启用 · 同步需要留意' : '已自动启用' : subscription ? '已停止' : s.currentThreadId === s.selectedThreadId ? s.error ? '自动启用需要重试' : '等待自动启用' : '待选择对话';
  const disabled = pending || !s.loaded || !s.selectedThreadId || unavailable;
  return `<section class="context-card codex-conversation-card" aria-labelledby="codex-conversation-title" aria-busy="${pending || s.loading}">
    <div class="context-card-heading"><div><h2 id="codex-conversation-title">${icon('message', 19)}Codex 实时记录</h2><p class="context-muted">${permissionPaused ? '这段对话的自动记录已暂停，已保存的内容仍可查看。' : '当前对话默认自动记录、压缩并归入项目，每轮完成后追加用户消息与助手回复，工具输出与推理不录入。'}</p></div><span class="codex-recording-state${active ? ' is-active' : ''}">${esc(label)}</span></div>
    <div class="codex-conversation-fields">
      <div class="field"><label for="codex-recording-thread">选择对话</label><select id="codex-recording-thread" data-codex-conversation-field="selectedThreadId"${pending ? ' disabled' : ''}>${options || '<option value="">等待发现本机对话</option>'}</select></div>
      <div class="field"><label for="codex-recording-project">保存到项目（可选）</label><input id="codex-recording-project" data-codex-conversation-field="projectId" maxlength="100" value="${esc(s.projectId)}" placeholder="例如 memoryui"${pending || enabled ? ' disabled' : ''}></div>
    </div>
    ${unavailable ? '<p class="codex-recording-feedback" role="status">本机 Codex 来源暂不可用，可刷新后重新检查。</p>' : ''}
    ${permissionPaused ? '<p class="codex-recording-feedback" role="status">当前不会读取或保存新消息。点击“继续记录此对话”将单独授权记录这段对话，也可停止记录。</p>' : ''}
    ${s.threadError ? `<p class="codex-recording-feedback" role="status">${esc(s.threadError)}</p>` : ''}
    <div class="context-actions">
      ${!enabled || permissionPaused ? `<button type="button" class="button primary" data-action="codex-recording-start"${disabled ? ' disabled' : ''}>${icon('message', 15)}${s.working === 'start' ? '正在启用…' : permissionPaused ? '继续记录此对话' : '开始记录此对话'}</button>` : ''}
      ${enabled ? `<button type="button" class="button" data-action="codex-recording-stop"${pending ? ' disabled' : ''}>${icon('pause', 15)}${s.working === 'stop' ? '正在停止…' : '停止记录此对话'}</button>` : ''}
      ${subscription ? `<button type="button" class="button" data-action="codex-recording-view"${pending ? ' disabled' : ''}>${icon('notebook', 15)}查看已记录内容</button>` : ''}
      <button type="button" class="button" data-action="codex-recording-refresh"${pending || s.loading ? ' disabled' : ''}>${icon('refresh', 15)}${s.loading ? '正在检查…' : '刷新状态'}</button>
    </div>
    ${subscription ? `<dl class="codex-recording-receipt"><div><dt>已保存消息</dt><dd>${subscription.savedCount === null ? '—' : subscription.savedCount} 条</dd></div><div><dt>最近同步</dt><dd>${esc(dateLabel(subscription.lastSyncedAt))}</dd></div>${subscription.issueCount ? `<div><dt>待留意来源</dt><dd>${subscription.issueCount} 项</dd></div>` : ''}</dl>` : ''}
    ${subscription?.lastError ? `<p class="codex-recording-feedback is-error" role="alert">${esc(subscription.lastError)}</p>` : ''}
    ${s.error ? `<p class="codex-recording-feedback is-error" role="alert" id="codex-recording-error" tabindex="-1">${esc(s.error)}</p>` : ''}
    ${s.notice ? `<p class="codex-recording-feedback" role="status">${esc(s.notice)}</p>` : ''}
  </section>`;
}
