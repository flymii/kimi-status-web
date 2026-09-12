import fs from 'node:fs';
import path from 'node:path';

/** Session discovery: index first, directory scan as the fallback. */

const INDEX_TAIL_LINES = 800;
const CACHE_TTL_MS = 4000;
const MAX_SESSIONS = 40;

let cache = { at: 0, sessions: [], key: null };

function readIndexTail(indexPath) {
  let text = '';
  try {
    const stat = fs.statSync(indexPath);
    const start = Math.max(0, stat.size - 512 * 1024);
    const fd = fs.openSync(indexPath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      const read = fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline < 0 ? '' : text.slice(newline + 1);
    }
  } catch {
    return [];
  }
  const lines = text.split('\n').filter(Boolean).slice(-INDEX_TAIL_LINES);
  const entries = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row && typeof row.sessionId === 'string' && typeof row.sessionDir === 'string') {
        entries.push({ id: row.sessionId, dir: row.sessionDir, workDir: row.workDir || '' });
      }
    } catch {
      // ignore malformed index rows
    }
  }
  return entries;
}

function readSessionMeta(sessionDir) {
  const statePath = path.join(sessionDir, 'state.json');
  let state = null;
  let mtimeMs = 0;
  try {
    const stat = fs.statSync(statePath);
    mtimeMs = stat.mtimeMs;
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    state = null;
  }
  return { state, mtimeMs };
}

function wirePaths(sessionDir) {
  const agentsDir = path.join(sessionDir, 'agents');
  const paths = [];
  let names = [];
  try {
    names = fs.readdirSync(agentsDir);
  } catch {
    return paths;
  }
  for (const name of names) {
    const wire = path.join(agentsDir, name, 'wire.jsonl');
    try {
      if (fs.statSync(wire).isFile()) paths.push({ agent: name, path: wire });
    } catch {
      // agent without a journal yet
    }
  }
  return paths;
}

function newestMtime(paths) {
  let newest = 0;
  for (const entry of paths) {
    try {
      const stat = fs.statSync(entry.path);
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch {
      // ignore
    }
  }
  return newest;
}

/**
 * Most recently active sessions first. Metadata comes from each session's
 * state.json; activity from the agents' journal mtimes.
 */
export function listSessions(paths, { limit = MAX_SESSIONS, force = false } = {}) {
  const key = paths.sessionIndexPath;
  const now = Date.now();
  if (!force && cache.key === key && now - cache.at < CACHE_TTL_MS) {
    return cache.sessions.slice(0, limit);
  }

  const seen = new Map();
  for (const entry of readIndexTail(paths.sessionIndexPath)) {
    seen.set(entry.id, entry);
  }
  if (seen.size === 0) {
    // No usable index: scan the sessions tree, newest working directories first.
    try {
      for (const wd of fs.readdirSync(paths.sessionsRoot, { withFileTypes: true })) {
        if (!wd.isDirectory()) continue;
        const wdDir = path.join(paths.sessionsRoot, wd.name);
        for (const session of fs.readdirSync(wdDir, { withFileTypes: true })) {
          if (!session.isDirectory()) continue;
          seen.set(session.name, {
            id: session.name,
            dir: path.join(wdDir, session.name),
            workDir: '',
          });
        }
      }
    } catch {
      // no sessions at all
    }
  }

  const sessions = [];
  for (const entry of seen.values()) {
    const { state, mtimeMs } = readSessionMeta(entry.dir);
    if (!state && mtimeMs === 0) continue;
    const wires = wirePaths(entry.dir);
    const activityAt = Math.max(mtimeMs, newestMtime(wires));
    const agents = state && state.agents && typeof state.agents === 'object'
      ? Object.keys(state.agents).length
      : wires.length;
    sessions.push({
      id: state?.id || entry.id,
      dir: entry.dir,
      cwd: state?.cwd || entry.workDir || '',
      title: typeof state?.title === 'string' ? state.title : '',
      updatedAt: Number.isFinite(state?.updatedAt) ? state.updatedAt : mtimeMs,
      activityAt,
      archived: state?.archived === true,
      agentCount: agents,
      wireCount: wires.length,
    });
  }
  sessions.sort((a, b) => b.activityAt - a.activityAt);
  cache = { at: now, sessions, key };
  return sessions.slice(0, limit);
}

export function findSession(paths, sessionId) {
  if (!sessionId) return null;
  const wanted = String(sessionId);
  const all = listSessions(paths, { limit: Number.MAX_SAFE_INTEGER });
  return all.find((s) => s.id === wanted || s.dir === wanted) || null;
}

/** The session the dashboard follows when the viewer has not pinned one. */
export function pickActiveSession(paths) {
  const all = listSessions(paths, { limit: MAX_SESSIONS });
  return all.find((s) => !s.archived) || all[0] || null;
}

export function sessionWires(sessionDir) {
  return wirePaths(sessionDir);
}
