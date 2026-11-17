import { CATEGORIES } from './memory-taxonomy.mjs';
import { PROFILE_SHARING_CLIENTS, PROFILE_SHARING_DEFAULT_CATEGORIES } from './profile-sharing-ui.js';

const clients = new Set(PROFILE_SHARING_CLIENTS.map(client => client.id));
const normalize = value => Array.isArray(value) ? CATEGORIES.filter(category => value.includes(category)) : [];
const same = (left, right) => left.length === right.length && left.every(category => right.includes(category));
const policyCopy = policy => policy && typeof policy === 'object' && Array.isArray(policy.categories)
  ? { enabled: policy.enabled === true, categories: normalize(policy.categories) } : null;
const signature = policy => JSON.stringify(policyCopy(policy));
const clientCheck = client => { if (!clients.has(client)) throw new RangeError('请选择 ChatGPT、WorkBuddy、Codex 或 Claude Code。'); return client; };

function validatePreview(data, client, enabled, categories) {
  if (!data || data.client !== client || data.profileSharing?.enabled !== enabled
    || !same(normalize(data.profileSharing?.categories), categories)
    || typeof data.previewToken !== 'string' || !data.previewToken
    || !Number.isSafeInteger(data.count) || data.count < 0
    || !Array.isArray(data.memoryIds) || data.memoryIds.length !== data.count
    || data.memoryIds.some(id => typeof id !== 'string' || !id)
    || new Set(data.memoryIds).size !== data.memoryIds.length) {
    throw new Error('未收到完整的共享范围，请重新加载后再保存。');
  }
  return data;
}

/** No DOM, timers, automatic writes, or ownership of the app snapshot. */
export function createProfileSharingController({ request, mutate, getSnapshot, onChange = () => {} } = {}) {
  if (typeof request !== 'function' || typeof mutate !== 'function' || typeof getSnapshot !== 'function') {
    throw new TypeError('共享控制器需要 request、mutate 和 getSnapshot。');
  }
  let selectedClient = 'codex';
  const states = new Map();
  const savedPolicy = client => {
    const policy = policyCopy(getSnapshot()?.connections?.find(connection => connection.id === client)?.profileSharing);
    return policy && (policy.enabled || policy.categories.length) ? policy : null;
  };
  const stateFor = client => {
    clientCheck(client);
    if (!states.has(client)) {
      const policy = savedPolicy(client);
      states.set(client, { categories: [...(policy?.categories ?? PROFILE_SHARING_DEFAULT_CATEGORIES)],
        baseline: signature(policy), preview: null, previewMemories: [], version: 0,
        dirty: false, loading: false, saving: false, error: '', notice: '' });
    }
    const state = states.get(client);
    const policy = savedPolicy(client);
    if (!state.dirty && !state.loading && !state.saving && state.baseline !== signature(policy)) {
      state.baseline = signature(policy);
      state.categories = [...(policy?.categories ?? PROFILE_SHARING_DEFAULT_CATEGORIES)];
      ++state.version;
      state.preview = null;
      state.previewMemories = [];
    }
    return state;
  };
  const invalidate = state => { ++state.version; state.preview = null; state.previewMemories = []; state.loading = false; };
  const anySaving = () => [...states.values()].some(state => state.saving);
  const latestRead = client => {
    const event = (getSnapshot()?.events || []).filter(event => event?.type === 'local.read'
      && event.connectionId === client && Array.isArray(event.memoryIds)
      && typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)))
      .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0];
    return event ? { client, at: event.at, count: event.memoryIds.length, kind: event.readDetails?.kind } : null;
  };
  function view(client = selectedClient) {
    const state = stateFor(client);
    return { client, policy: savedPolicy(client),
      masterEnabled: getSnapshot()?.connections?.find(connection => connection.id === client)?.enabled === true,
      selectedCategories: [...state.categories],
      preview: state.preview ? { ...state.preview, profileSharing: { ...state.preview.profileSharing, categories: [...state.preview.profileSharing.categories] },
        memoryIds: [...state.preview.memoryIds], memories: state.previewMemories.map(memory => ({ ...memory })) } : null,
      lastRead: latestRead(client), loading: state.loading, saving: state.saving,
      dirty: state.dirty, error: state.error, notice: state.notice };
  }
  const notify = () => onChange(view());

  async function load() {
    const client = selectedClient, state = stateFor(client);
    if (anySaving()) return false;
    invalidate(state);
    state.error = '';
    if (!state.categories.length) { notify(); return false; }
    const version = state.version, categories = [...state.categories];
    state.loading = true;
    notify();
    const current = () => selectedClient === client && state.version === version && same(state.categories, categories);
    try {
      const data = await request('/api/profile-sharing/preview', { client, enabled: true, categories });
      if (!current()) return false;
      validatePreview(data, client, true, categories);
      // Preview's owner snapshot is only used to display the exact reviewed
      // records. It is never passed to mutate or applied to the app snapshot.
      const source = Array.isArray(data.snapshot?.memories) ? data.snapshot.memories : getSnapshot()?.memories || [];
      const byId = new Map(source.map(memory => [memory.id, memory]));
      const { snapshot: _snapshot, ...preview } = data;
      state.preview = { ...preview, profileSharing: policyCopy(data.profileSharing), memoryIds: [...data.memoryIds] };
      state.previewMemories = data.memoryIds.map(id => byId.get(id)).filter(Boolean).map(memory => ({ ...memory }));
      return true;
    } catch (error) {
      if (!current()) return false;
      state.error = error?.message || '无法加载共享范围，请重试。';
      return false;
    } finally {
      if (current()) { state.loading = false; notify(); }
    }
  }

  async function commit({ enabled, categories, preview = null, revoke = false }) {
    const client = selectedClient, state = stateFor(client);
    if (anySaving()) return false;
    const draft = [...state.categories], draftDirty = state.dirty;
    invalidate(state);
    const version = state.version;
    state.saving = true;
    state.error = '';
    state.notice = '';
    notify();
    try {
      const reviewed = preview ?? await request('/api/profile-sharing/preview', { client, enabled, categories: [...categories] });
      if (state.version !== version || selectedClient !== client) return false;
      validatePreview(reviewed, client, enabled, categories);
      await mutate('/api/profile-sharing', { client, enabled, categories: [...categories], previewToken: reviewed.previewToken });
      const currentPolicy = savedPolicy(client);
      state.baseline = signature(currentPolicy);
      state.categories = !enabled && !revoke && draftDirty ? draft
        : [...(currentPolicy?.categories ?? (revoke ? PROFILE_SHARING_DEFAULT_CATEGORIES : categories))];
      state.dirty = !enabled && !revoke && draftDirty;
      state.notice = revoke ? '已撤回这组主题，其他授权保留。'
        : enabled ? '主题授权已保存，实际读取记录会在下方显示。' : '已暂停这组主题，其他授权保留。';
      return true;
    } catch (error) {
      state.categories = draft;
      state.dirty = draftDirty;
      state.error = error?.code === 'REVISION_CONFLICT' || error?.status === 409 || error?.statusCode === 409
        ? '资料或授权已有变化，请重新预览后再保存。你的主题选择已保留。'
        : `${error?.message || '共享设置未保存。'} 你的主题选择已保留，请重新预览后重试。`;
      return false;
    } finally {
      state.saving = false;
      // A token is single-use, including after an uncertain network failure.
      state.preview = null;
      state.previewMemories = [];
      notify();
    }
  }

  async function save() {
    const state = stateFor(selectedClient);
    if (anySaving()) return false;
    const preview = state.preview;
    if (state.loading || !state.categories.length || !preview
      || !same(normalize(preview.profileSharing?.categories), state.categories)) {
      state.error = '请先加载并核对当前范围，再保存主题授权。';
      notify();
      return false;
    }
    const saved = await commit({ enabled: true, categories: [...state.categories], preview });
    if (saved) await load();
    return saved;
  }

  async function setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('启用状态必须是布尔值。');
    if (enabled) return save();
    if (anySaving()) return false;
    const policy = savedPolicy(selectedClient);
    if (!policy) return false;
    const saved = await commit({ enabled: false, categories: [...policy.categories] });
    if (saved) await load();
    return saved;
  }

  async function revoke() {
    if (anySaving() || !savedPolicy(selectedClient)) return false;
    return commit({ enabled: false, categories: [], revoke: true });
  }

  function selectClient(client) {
    clientCheck(client);
    if (anySaving()) return Promise.resolve(false);
    invalidate(stateFor(selectedClient));
    selectedClient = client;
    const state = stateFor(client);
    invalidate(state);
    state.error = '';
    state.notice = '';
    return load();
  }

  function setCategory(category, checked) {
    if (!CATEGORIES.includes(category)) throw new RangeError('请选择现有主题。');
    if (typeof checked !== 'boolean') throw new TypeError('主题选择必须是布尔值。');
    if (anySaving()) return Promise.resolve(false);
    const state = stateFor(selectedClient);
    const next = new Set(state.categories);
    if (checked) next.add(category); else next.delete(category);
    state.categories = normalize([...next]);
    state.dirty = true;
    state.notice = '';
    return load();
  }

  return { view, selectClient, setCategory, load, refresh: load, save, setEnabled, revoke };
}
