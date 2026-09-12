import { execFile } from 'node:child_process';

/** Non-blocking git branch lookup with a short cache, used for the header. */

const TTL_MS = 10000;
const cache = new Map();

export function branchFor(cwd, { timeoutMs = 1200 } = {}) {
  if (!cwd || typeof cwd !== 'string') return Promise.resolve(null);
  const now = Date.now();
  const hit = cache.get(cwd);
  if (hit && now - hit.at < TTL_MS) return Promise.resolve(hit.value);
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd, timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        const value = error ? null : String(stdout).trim() || null;
        cache.set(cwd, { at: Date.now(), value });
        resolve(value);
      },
    );
  });
}
