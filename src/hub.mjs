import { pluginVersion } from './runtime.mjs';
import { findSession, pickActiveSession } from './session-locator.mjs';
import { SessionTracker } from './session-tracker.mjs';

/**
 * Metric tracking behind every entry point — the HTTP API, the CLI snapshot
 * command, and the userscript. One tracker cache, one follow target, one
 * snapshot builder.
 */
export function createMetricsHub({ paths, config, log = () => {}, mode = 'dashboard' }) {
  const startedAt = Date.now();
  const trackers = new Map();
  let followedId = null;
  let port = config.port;

  function trackerFor(session) {
    let tracker = trackers.get(session.id);
    if (!tracker) {
      tracker = new SessionTracker(session);
      trackers.set(session.id, tracker);
      while (trackers.size > config.keepSessions) {
        const oldest = [...trackers.entries()]
          .filter(([id]) => id !== session.id)
          .sort((a, b) => a[1].loadedAt - b[1].loadedAt)[0];
        if (!oldest) break;
        trackers.delete(oldest[0]);
      }
    } else {
      tracker.session = { ...session };
    }
    return tracker;
  }

  /** Resolve a session id (or "auto" / null) to its tracker. */
  function resolve(requested) {
    const wanted = requested && requested !== 'auto'
      ? String(requested)
      : (followedId || 'auto');
    try {
      if (wanted === 'auto') {
        const active = pickActiveSession(paths);
        return active ? trackerFor(active) : null;
      }
      const session = findSession(paths, wanted);
      return session ? trackerFor(session) : null;
    } catch (error) {
      log(`session resolve failed: ${error && error.message}`);
      return null;
    }
  }

  function serverInfo(extra = {}) {
    return {
      name: 'kimi-status-web',
      mode,
      version: pluginVersion(),
      pid: process.pid,
      port,
      uptimeMs: Date.now() - startedAt,
      home: paths.dir,
      tickMs: config.tickMs,
      ...extra,
    };
  }

  function emptySnapshot() {
    return {
      ok: true,
      generatedAt: Date.now(),
      empty: true,
      server: serverInfo(),
      session: null,
      headline: {},
      turn: {},
      totals: {},
      agents: [],
      steps: [],
      tools: [],
      window: {},
    };
  }

  /** Advance every reader for the followed session. */
  function tick() {
    const tracker = resolve(null);
    if (!tracker) return { changed: true, snapshot: emptySnapshot() };
    try {
      const { changed, snapshot } = tracker.poll();
      return { changed, snapshot: { ...snapshot, server: serverInfo() } };
    } catch (error) {
      log(`poll failed: ${error && error.message}`);
      return { changed: false, snapshot: emptySnapshot() };
    }
  }

  /** One-shot snapshot for a specific session (or the followed one). */
  function snapshotFor(requested) {
    const tracker = resolve(requested);
    if (!tracker) return emptySnapshot();
    try {
      const { snapshot } = tracker.poll();
      return { ...snapshot, server: serverInfo() };
    } catch (error) {
      log(`poll failed: ${error && error.message}`);
      return emptySnapshot();
    }
  }

  return {
    setPort(value) { port = value; },
    setFollowing(id) { followedId = id && id !== 'auto' ? String(id) : null; },
    get following() { return followedId; },
    trackerFor,
    resolve,
    tick,
    snapshotFor,
    serverInfo,
  };
}
