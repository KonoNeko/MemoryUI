import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { createAtomicFileStorage } from './atomic-file-storage.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');

export function getWorkspaceId(root, env = {}) {
  if (env.MEMORYUI_WORKSPACE_ID !== undefined) {
    if (typeof env.MEMORYUI_WORKSPACE_ID !== 'string' || !/^[0-9a-f]{16}$/i.test(env.MEMORYUI_WORKSPACE_ID)) throw new Error('Invalid MemoryUI workspace identity');
    return env.MEMORYUI_WORKSPACE_ID.toLowerCase();
  }
  const absolute = path.resolve(root);
  return digest(process.platform === 'win32' ? absolute.toLowerCase() : absolute).slice(0, 16);
}

export function getApplicationDirectory(env = process.env) {
  let userData;
  if (process.platform === 'win32') userData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  else if (process.platform === 'darwin') userData = path.join(os.homedir(), 'Library', 'Application Support');
  else userData = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(userData, 'MemoryUI');
}

export function getDataDirectory(root, env = process.env) {
  if (env.MEMORYUI_DATA_DIR) return path.resolve(env.MEMORYUI_DATA_DIR);
  return path.join(getApplicationDirectory(env), getWorkspaceId(root, env));
}

// MemoryStore uses the synchronous Storage shape. Persist outside the project,
// so UI and Codex share one authority and personal data does not enter OneDrive/Git.
export function createFileStorage({ root, env = process.env, directory = getDataDirectory(root, env), fileSystem }) {
  return createAtomicFileStorage({ directory, basename: 'memory.json', createDirectory: true, fileSystem,
    messages: { unreadable: 'Memory data is too large or unreadable', tooLarge: 'Memory data exceeds storage limit', changed: 'Memory data changed outside this service' } });
}
