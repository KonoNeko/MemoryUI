import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHookInput, runBoundHook } from './capture-prompt.mjs';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export function lifecycleEvent(value, action) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || !EVENTS.includes(value.hook_event_name)
    || !ID.test(value.session_id ?? '') || value.agent_id || value.agent_type || value.role && value.role !== 'user'
    || typeof value.cwd !== 'string' || value.cwd.length > 4096 || /[\x00-\x1f]/.test(value.cwd)
    || !(path.posix.isAbsolute(value.cwd) || path.win32.isAbsolute(value.cwd))) return null;
  if (!['check-service', 'workspace', 'save-memory'].includes(action)
    || action === 'check-service' && value.hook_event_name !== 'SessionStart' || action === 'save-memory' && value.hook_event_name !== 'Stop') return null;
  for (const key of ['turn_id', 'event_id']) if (value[key] !== undefined && !ID.test(value[key])) return null;
  return { hook_event_name: value.hook_event_name, session_id: value.session_id, cwd: value.cwd,
    ...Object.fromEntries(['turn_id', 'event_id'].filter(key => value[key] !== undefined).map(key => [key, value[key]])) };
}

export async function lifecycleHook(action, { input = process.stdin, env = process.env, spawnImpl, timeoutMs } = {}) {
  if (env.MEMORYUI_CAPTURE_WORKER === '1' || env.MEMORYUI_EXTRACTION_WORKER === '1') return;
  const event = lifecycleEvent(await readHookInput(input), action);
  if (!event) return;
  // Matching commands run in parallel. Each connects independently; Stop
  // never requests a continuation or opens a payload-supplied transcript path.
  await runBoundHook('lifecycle-event', { action, event }, { env, ...(spawnImpl ? { spawnImpl } : {}), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  lifecycleHook(process.argv[2]).catch(() => {}).finally(() => { process.stdout.write('{}\n'); });
}
