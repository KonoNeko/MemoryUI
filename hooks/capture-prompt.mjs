import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MAX_INPUT_BYTES = 128 * 1024;
const MAX_PROMPT_CHARS = 16000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function hookEvent(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || value.hook_event_name !== 'UserPromptSubmit'
    || value.agent_id || value.agent_type
    || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > MAX_PROMPT_CHARS || value.prompt.includes('\0')
    || !ID.test(value.session_id ?? '') || (value.turn_id !== undefined && !ID.test(value.turn_id))
    || (value.event_id !== undefined && !ID.test(value.event_id)) || (value.role !== undefined && value.role !== 'user')) return null;
  return { hook_event_name: 'UserPromptSubmit', session_id: value.session_id,
    ...(value.turn_id === undefined ? {} : { turn_id: value.turn_id }), ...(value.event_id === undefined ? {} : { event_id: value.event_id }), prompt: value.prompt };
}

export async function readHookInput(input = process.stdin) {
  let size = 0;
  const chunks = [];
  for await (const chunk of input) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_INPUT_BYTES) return null;
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

export async function runBoundHook(command, event, { env = process.env, spawnImpl = spawn, timeoutMs = 4500 } = {}) {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const runner = path.join(pluginRoot, 'skills', 'memoryui', 'scripts', 'run.mjs');
  const childEnv = { ...env, MEMORYUI_CAPTURE_HOOK: '1' };
  // Lifecycle input, rather than a service startup environment, identifies the
  // current session. No hook starts recording an unrelated inherited thread.
  delete childEnv.CODEX_THREAD_ID; delete childEnv.CODEX_SESSION_ID;
  await new Promise(resolve => {
    let child, timer, settled = false;
    const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
    try {
      child = spawnImpl(process.execPath, [runner, command], { cwd: pluginRoot, env: childEnv,
        windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'ignore'] });
      child.once('error', done); child.once('close', done);
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify(event));
      timer = setTimeout(() => { try { child.kill(); } catch {} done(); }, Math.max(1, Math.min(timeoutMs, 4500)));
    } catch { done(); }
  });
}

export async function capturePromptHook({ input = process.stdin, env = process.env, spawnImpl = spawn, timeoutMs = 4500 } = {}) {
  // Background extraction has its own user-shaped prompt. It must never be
  // mistaken for a human statement or recursively schedule another worker.
  if (env.MEMORYUI_CAPTURE_WORKER === '1' || env.MEMORYUI_EXTRACTION_WORKER === '1') return;
  let event;
  try { event = hookEvent(await readHookInput(input)); } catch { return; }
  if (!event) return;
  // Resolve the packaged runner from this script, never from cwd, hook input,
  // callback URLs or a user-provided PLUGIN_ROOT environment override.
  await runBoundHook('capture-event', event, { env, spawnImpl, timeoutMs });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // An observational hook never blocks or approves a Codex operation and never
  // sends raw user text back as developer instructions or a warning message.
  capturePromptHook().catch(() => {}).finally(() => { process.stdout.write('{}\n'); });
}
