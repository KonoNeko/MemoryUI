export const STORAGE_ISSUES = Object.freeze(['LOCK_PRESENT', 'CLEANUP_FAILED', 'STATUS_UNAVAILABLE']);
export const STORAGE_CLEANUP_STAGES = Object.freeze(['temp-close', 'temp-unlink', 'lock-close', 'lock-unlink']);
const statuses = ['ready', 'attention', 'unavailable', 'in-memory', 'unknown'];
const own = (value, key) => Object.hasOwn(value, key);
const unavailable = () => ({ status: 'unavailable', issues: ['STATUS_UNAVAILABLE'] });
function list(value, allowed) {
  return Array.isArray(value) && value.length <= allowed.length && Reflect.ownKeys(value).length === value.length + 1
    && new Set(value).size === value.length && value.every(item => allowed.includes(item));
}

// Owner diagnostics are deliberately a closed projection. Neither adapter
// paths, operating-system messages nor arbitrary injected metadata reach UI or
// agent status responses. This does not inspect or modify any memory record.
export function sanitizeStorageStatus(value) {
  try {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => !['status', 'issues', 'lastWriteCommitted', 'cleanupStages'].includes(key))
    || !statuses.includes(value.status) || !list(value.issues, STORAGE_ISSUES)
    || (own(value, 'lastWriteCommitted') && typeof value.lastWriteCommitted !== 'boolean')
    || (own(value, 'cleanupStages') && !list(value.cleanupStages, STORAGE_CLEANUP_STAGES))) return unavailable();
  return { status: value.status, issues: [...value.issues],
    ...(own(value, 'lastWriteCommitted') ? { lastWriteCommitted: value.lastWriteCommitted } : {}),
    ...(own(value, 'cleanupStages') ? { cleanupStages: [...value.cleanupStages] } : {}) };
  } catch { return unavailable(); }
}

export function readStorageStatus(storage) {
  if (storage == null) return { status: 'in-memory', issues: [] };
  try {
    if (typeof storage.getStatus !== 'function') return { status: 'unknown', issues: [] };
    return sanitizeStorageStatus(storage.getStatus());
  } catch { return unavailable(); }
}
