import { createHash, randomUUID } from 'node:crypto';
import * as nodeFileSystem from 'node:fs';
import path from 'node:path';

export const MAX_STORAGE_BYTES = 32 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const absent = error => error?.code === 'ENOENT';

// Synchronous Storage adapter shared by the authority and its capture receipts.
// The injected filesystem is an internal test seam, never a request parameter.
// Rename is the commit boundary: cleanup diagnostics must not turn a committed
// replacement into a reported failure and cause callers to roll back memory.
export function createAtomicFileStorage({ directory, basename, createDirectory = false, messages, fileSystem = {} }) {
  if (typeof basename !== 'string' || !basename || ['.', '..'].includes(basename) || /[/\\]/.test(basename)
    || path.isAbsolute(basename) || /[:\x00]/.test(basename)) throw new Error('Invalid storage basename');
  const io = { ...nodeFileSystem, ...fileSystem };
  const folder = path.resolve(directory);
  const filename = path.join(folder, basename);
  const lockFile = `${filename}.lock`;
  const ensureDirectory = () => io.mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (createDirectory) ensureDirectory();
  let lastDigest, lastWriteCommitted;
  let operationUnavailable = false;
  let cleanupStages = [];

  function current() {
    if (!io.existsSync(filename)) return null;
    const details = io.statSync(filename);
    if (!details.isFile() || details.size > MAX_STORAGE_BYTES) throw new Error(messages.unreadable);
    const value = io.readFileSync(filename, 'utf8');
    // Check the bytes actually read as well as stat, in case the file grew.
    if (Buffer.byteLength(value, 'utf8') > MAX_STORAGE_BYTES) throw new Error(messages.unreadable);
    return value;
  }

  function noteCleanup(stage) {
    if (!cleanupStages.includes(stage)) cleanupStages.push(stage);
  }

  return {
    getItem() {
      try {
        const value = current();
        lastDigest = value === null ? null : digest(value);
        operationUnavailable = false;
        return value;
      } catch (error) { operationUnavailable = true; throw error; }
    },
    setItem(_key, value) {
      lastWriteCommitted = false;
      operationUnavailable = false;
      cleanupStages = [];
      let lock, lockIdentity, descriptor, temp, primary, failed = false, acquiringLock = false;
      const cleanup = (stage, action) => {
        try { action(); } catch { noteCleanup(stage); }
      };
      try {
        if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_STORAGE_BYTES) throw new Error(messages.tooLarge);
        const nextDigest = digest(value);
        ensureDirectory();
        acquiringLock = true;
        lock = io.openSync(lockFile, 'wx', 0o600);
        acquiringLock = false;
        lockIdentity = io.fstatSync(lock);
        const previous = current();
        const previousDigest = previous === null ? null : digest(previous);
        if (lastDigest !== undefined && previousDigest !== lastDigest) throw new Error(messages.changed);
        const candidate = `${filename}.${randomUUID()}.tmp`;
        descriptor = io.openSync(candidate, 'wx', 0o600);
        temp = candidate;
        io.writeFileSync(descriptor, value, 'utf8');
        io.fsyncSync(descriptor);
        // A failing close may already have released its descriptor. Never
        // retry it, since that number can have been reused by the OS.
        const toClose = descriptor;
        descriptor = undefined;
        io.closeSync(toClose);
        io.renameSync(temp, filename);
        temp = undefined;
        lastDigest = nextDigest;
        lastWriteCommitted = true;
      } catch (error) {
        failed = true;
        primary = error;
        operationUnavailable = !(acquiringLock && error?.code === 'EEXIST');
      } finally {
        if (descriptor !== undefined) {
          const toClose = descriptor;
          descriptor = undefined;
          cleanup('temp-close', () => io.closeSync(toClose));
        }
        if (temp) cleanup('temp-unlink', () => {
          try { io.unlinkSync(temp); } catch (error) { if (!absent(error)) throw error; }
        });
        if (lock !== undefined) {
          const toClose = lock;
          lock = undefined;
          cleanup('lock-close', () => io.closeSync(toClose));
          cleanup('lock-unlink', () => {
            // A different process may have replaced the pathname. Leave any
            // unverified lock untouched rather than deleting another writer's.
            let present;
            try { present = io.statSync(lockFile); } catch (error) { if (absent(error)) return; throw error; }
            if (!lockIdentity || present.dev !== lockIdentity.dev || present.ino !== lockIdentity.ino) throw new Error('Lock identity changed');
            io.unlinkSync(lockFile);
          });
        }
      }
      if (failed) throw primary;
    },
    getStatus() {
      const issues = [];
      let unavailable = operationUnavailable;
      try { io.statSync(lockFile); issues.push('LOCK_PRESENT'); }
      catch (error) { if (!absent(error)) unavailable = true; }
      if (cleanupStages.length) issues.push('CLEANUP_FAILED');
      if (unavailable) issues.push('STATUS_UNAVAILABLE');
      return { status: unavailable ? 'unavailable' : issues.length ? 'attention' : 'ready', issues,
        ...(lastWriteCommitted === undefined ? {} : { lastWriteCommitted }),
        ...(cleanupStages.length ? { cleanupStages: [...cleanupStages] } : {}) };
    },
  };
}
