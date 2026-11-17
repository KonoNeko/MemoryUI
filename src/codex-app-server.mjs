import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export class CodexTransportError extends Error {
  constructor(code, message, details) { super(message); this.name = 'CodexTransportError'; this.code = code; this.details = details; }
}

export async function findCodexExecutable(env = process.env) {
  if (env.MEMORYUI_CODEX_EXECUTABLE) {
    if (!path.isAbsolute(env.MEMORYUI_CODEX_EXECUTABLE) || !(await stat(env.MEMORYUI_CODEX_EXECUTABLE)).isFile()) throw new CodexTransportError('CODEX_UNAVAILABLE', '找不到已配置的 Codex 程序。');
    return env.MEMORYUI_CODEX_EXECUTABLE;
  }
  if (process.platform !== 'win32') return 'codex';
  const directory = path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'OpenAI/Codex/bin');
  const candidates = [];
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name, 'codex.exe');
      try { const info = await stat(filename); if (info.isFile()) candidates.push({ filename, modified: info.mtimeMs }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  candidates.sort((a, b) => b.modified - a.modified || a.filename.localeCompare(b.filename));
  return candidates[0]?.filename || 'codex.exe';
}

const READ_METHODS = new Set(['thread/list', 'thread/read', 'thread/turns/list', 'thread/items/list', 'hooks/list']);

/** A local, read-only app-server connection. It never resumes or starts chats. */
export function createCodexReadOnlyTransport({ env = process.env, cwd = os.homedir(), spawnImpl = spawn, executable, timeoutMs = 25000 } = {}) {
  let child, opening, initialized = false, nextId = 0, buffer = '', idleTimer;
  const pending = new Map();
  const stop = error => {
    initialized = false; buffer = ''; clearTimeout(idleTimer);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear(); const processToStop = child; child = null; opening = null;
    if (processToStop && !processToStop.killed) processToStop.kill();
  };
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new CodexTransportError('CODEX_TIMEOUT', '读取 Codex 对话超时，请稍后重试。')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => {
        if (error && pending.has(id)) { pending.delete(id); clearTimeout(timer); reject(new CodexTransportError('CODEX_UNAVAILABLE', 'Codex 连接已关闭。')); }
      });
    });
  }
  async function open() {
    if (initialized && child) return;
    if (opening) return opening;
    opening = (async () => {
      const command = executable || await findCodexExecutable(env);
      child = spawnImpl(command, ['app-server'], { cwd, env: { ...env, MEMORYUI_EXTRACTION_WORKER: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const connection = child;
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stderr.on('data', () => {}); // Provider diagnostics never become user memory.
      child.on('error', () => { if (child === connection) stop(new CodexTransportError('CODEX_UNAVAILABLE', '无法启动本机 Codex，请确认已安装并登录。')); });
      child.on('exit', () => { if (child === connection) stop(new CodexTransportError('CODEX_UNAVAILABLE', '本机 Codex 连接已结束。')); });
      child.stdout.on('data', bytes => {
        if (child !== connection) return;
        buffer += bytes.toString('utf8');
        if (Buffer.byteLength(buffer, 'utf8') > 16 * 1024 * 1024) { stop(new CodexTransportError('CODEX_RESPONSE_LIMIT', 'Codex 返回的历史超出单次读取限制。')); return; }
        let split;
        while ((split = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
          if (!line.trim()) continue;
          let message; try { message = JSON.parse(line); } catch { continue; }
          if (message.method && Object.hasOwn(message, 'id')) {
            child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Read-only history client does not perform client actions.' } }) + '\n');
            continue;
          }
          const request = pending.get(message.id); if (!request) continue;
          pending.delete(message.id); clearTimeout(request.timer);
          if (message.error) request.reject(new CodexTransportError(message.error.code, 'Codex 暂时无法提供这部分历史。', message.error));
          else request.resolve(message.result);
        }
      });
      await send('initialize', { clientInfo: { name: 'memoryui_history', title: 'MemoryUI', version: '0.13.0' }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
      initialized = true;
    })();
    try { await opening; } catch (error) { stop(error); throw error; }
    finally { opening = null; }
  }
  return {
    // Candidates documented by the protocol; callers handle a specific
    // unsupported-method response before using the legacy read-only route.
    capabilities: [...READ_METHODS],
    async request(method, params = {}) {
      if (!READ_METHODS.has(method)) throw new CodexTransportError('READ_ONLY_METHOD_REQUIRED', '历史来源只允许读取，不会创建、继续或修改对话。');
      clearTimeout(idleTimer); await open();
      try { return await send(method, params); }
      finally { if (!pending.size) { idleTimer = setTimeout(() => stop(new CodexTransportError('CODEX_IDLE', '连接空闲结束。')), 30000); idleTimer.unref?.(); } }
    },
    close() { stop(new CodexTransportError('CODEX_CLOSED', '历史读取已结束。')); },
  };
}
