import path from 'node:path';
import { createAtomicFileStorage } from './atomic-file-storage.mjs';
import { getDataDirectory, getWorkspaceId } from './server-storage.mjs';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'];
const ACTIONS = ['check-service', 'workspace', 'save-memory'];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const copy = value => structuredClone(value);
export class CodexLifecycleError extends Error {
  constructor(message, code = 'CODEX_LIFECYCLE_INVALID', status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = message => { throw new CodexLifecycleError(message); };

// Workspace paths are metadata only. Never open cwd, transcript_path or any
// callback supplied by a hook payload, and never accept assistant text here.
export function normalizeCodexLifecycleEvent(value) {
  if (!plain(value) || !EVENTS.includes(value.hook_event_name) || !ID.test(value.session_id ?? '')) fail('需要有效的 Codex 生命周期事件。');
  if (value.agent_id || value.agent_type || value.role && value.role !== 'user') return null;
  if (typeof value.cwd !== 'string' || !value.cwd.trim() || value.cwd.length > 4096 || /[\x00-\x1f]/.test(value.cwd)
    || !(path.posix.isAbsolute(value.cwd) || path.win32.isAbsolute(value.cwd))) fail('事件需要有效的绝对工作区标识。');
  for (const key of ['turn_id', 'event_id']) if (value[key] !== undefined && !ID.test(value[key])) fail('生命周期事件编号无效。');
  if (value.stop_hook_active !== undefined && typeof value.stop_hook_active !== 'boolean') fail('Stop 状态无效。');
  return { hook_event_name: value.hook_event_name, session_id: value.session_id, cwd: value.cwd,
    ...Object.fromEntries(['turn_id', 'event_id'].filter(key => value[key] !== undefined).map(key => [key, value[key]])) };
}

export function codexWorkspaceProject(cwd) {
  const workspace = path.resolve(cwd);
  return { workspace, projectId: `${(path.basename(workspace) || 'workspace').slice(0, 100)}--${getWorkspaceId(workspace)}` };
}

export function createCodexLifecycleStorage({ root, env = process.env, directory = getDataDirectory(root, env), fileSystem }) {
  return createAtomicFileStorage({ directory, basename: 'codex-lifecycle.json', fileSystem,
    messages: { unreadable: 'Invalid Codex lifecycle metadata', tooLarge: 'Codex lifecycle metadata exceeds storage limit', changed: 'Codex lifecycle metadata changed outside this service' } });
}

export function createCodexLifecycle({ promptQueue, getRecorder, getContextMemory, schedulePrompts, recordingEnabled = true, storage = null, clock = () => Date.now() }) {
  let sessions = [], flight = null, pendingSync = false, pendingPrompts = false, closed = false, lastError = null;
  const load = () => {
    if (!storage) return;
    const serialized = storage?.getItem('codex-lifecycle');
    if (serialized == null) { sessions = []; return; }
    try {
      const data = JSON.parse(serialized);
      if (data.version !== 1 || !Array.isArray(data.sessions) || data.sessions.length > 128) throw Error();
      const seen = new Set();
      for (const s of data.sessions) {
        if (!plain(s) || Object.keys(s).some(key => !['sessionId', 'workspace', 'projectId', 'lastEvent', 'lastAction', 'updatedAt'].includes(key))
          || !ID.test(s.sessionId) || seen.has(s.sessionId) || !EVENTS.includes(s.lastEvent) || !ACTIONS.includes(s.lastAction)
          || !Number.isFinite(Date.parse(s.updatedAt)) || s.projectId !== null && (typeof s.projectId !== 'string' || s.projectId.length > 200)) throw Error();
        normalizeCodexLifecycleEvent({ hook_event_name: s.lastEvent, session_id: s.sessionId, cwd: s.workspace });
        seen.add(s.sessionId);
      }
      sessions = data.sessions;
    } catch { throw new CodexLifecycleError('生命周期记录无法读取，原数据未被重置。', 'CODEX_LIFECYCLE_STORAGE_INVALID', 503); }
  };
  const schedule = (sync, prompts) => {
    pendingSync ||= sync; pendingPrompts ||= prompts;
    if (flight || closed || !pendingSync && !pendingPrompts) return;
    flight = Promise.resolve().then(async () => {
      // A Stop arriving during sync requests one trailing pass, so a final
      // assistant item cannot be lost behind an earlier in-progress read.
      while (!closed && (pendingSync || pendingPrompts)) {
        const syncNow = pendingSync, promptsNow = pendingPrompts;
        pendingSync = false; pendingPrompts = false;
        if (syncNow) try { await getRecorder().syncAfterCurrent(); } catch { lastError = 'RECORDING_SYNC_FAILED'; }
        if (promptsNow) try { await schedulePrompts(); } catch { lastError = 'PROMPT_PROCESSING_FAILED'; }
      }
    }).finally(() => { flight = null; });
  };
  return {
    handle(input) {
      if (!plain(input) || Object.keys(input).some(key => !['client', 'action', 'event'].includes(key)) || input.client !== 'codex' || !ACTIONS.includes(input.action)) fail('需要绑定 Codex 的生命周期操作。');
      const event = normalizeCodexLifecycleEvent(input.event), action = input.action;
      if (!event) return { accepted: false, reason: 'non_user_agent' };
      if (action === 'check-service' && event.hook_event_name !== 'SessionStart' || action === 'save-memory' && event.hook_event_name !== 'Stop') fail('生命周期事件与操作不匹配。');
      if (action === 'check-service') return { accepted: true, action, serviceReady: true };
      const permission = promptQueue.status();
      if (!permission.allowed) return { accepted: false, reason: permission.reason };
      load();
      const workspace = codexWorkspaceProject(event.cwd);
      const previous = sessions.find(s => s.sessionId === event.session_id);
      const recorder = getRecorder(), existing = recorder.status().subscriptions.find(s => s.threadId === event.session_id);
      const saved = getContextMemory().getSnapshot().conversations.find(s => s.client === 'codex' && s.conversationId === event.session_id);
      const projectId = existing ? existing.projectId : saved ? saved.projectId : previous ? previous.projectId : workspace.projectId;
      const projectAllowed = recordingEnabled && permission.categories.includes('当前项目');
      if (!existing && projectAllowed) recorder.startAutomatic({ threadId: event.session_id, ...(projectId === null ? {} : { projectId }), consent: true });
      const recording = existing?.enabled === false ? 'paused' : projectAllowed ? 'scheduled' : 'not_authorized';
      // Once bound, a session's workspace/project identity stays stable even
      // when Codex changes cwd inside the conversation.
      const next = { sessionId: event.session_id, workspace: previous?.workspace ?? workspace.workspace,
        projectId, lastEvent: event.hook_event_name, lastAction: action, updatedAt: new Date(clock()).toISOString() };
      sessions = [next, ...sessions.filter(s => s.sessionId !== event.session_id)].slice(0, 128);
      storage?.setItem('codex-lifecycle', JSON.stringify({ version: 1, sessions }));
      schedule(recording === 'scheduled', action === 'save-memory');
      return { accepted: true, action, sessionId: event.session_id, projectId: next.projectId, recording,
        ...(action === 'save-memory' ? { processing: 'scheduled' } : {}) };
    },
    status() { load(); return { sessions: copy(sessions), processing: flight !== null, lastError }; },
    async idle() { while (flight) await flight; },
    close() { closed = true; pendingSync = false; pendingPrompts = false; },
  };
}
