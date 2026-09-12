import { listSessions } from './session-locator.mjs';

/** JSON + SSE API behind the panel, the CLI and the userscript. */

const HEARTBEAT_MS = 10000;
const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/**
 * Cross-origin reads are allowed only from loopback pages, so a userscript on
 * the kimi web page (or any local dashboard) can read metrics, while a random
 * website in the same browser cannot.
 */
export function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !LOCAL_ORIGIN.test(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'origin',
  };
}

export function sendJson(res, status, payload, extra = null) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...(extra || {}),
  });
  res.end(body);
}

export function sendText(res, status, body, type = 'text/plain; charset=utf-8', extra = null) {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...(extra || {}),
  });
  res.end(body);
}

export function createApiRoutes({ paths, hub, log = () => {} }) {
  const clients = new Set();
  let lastSnapshot = null;
  let lastBroadcastAt = 0;

  function broadcast(snapshot, { force = false } = {}) {
    if (snapshot) lastSnapshot = snapshot;
    if (!lastSnapshot || clients.size === 0) return;
    const now = Date.now();
    if (!force && now - lastBroadcastAt < HEARTBEAT_MS) return;
    lastBroadcastAt = now;
    const frame = `event: snapshot\ndata: ${JSON.stringify(lastSnapshot)}\n\n`;
    for (const res of clients) {
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
      }
    }
  }

  /** Poll the followed session once and push the result to open streams. */
  function tick() {
    const { changed, snapshot } = hub.tick();
    broadcast(snapshot, { force: changed });
    return snapshot;
  }

  function openStream(req, res, cors = null) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      ...(cors || {}),
    });
    res.write(': connected\n\n');
    const initial = lastSnapshot || hub.snapshotFor(null);
    lastSnapshot = initial;
    res.write(`event: snapshot\ndata: ${JSON.stringify(initial)}\n\n`);
    clients.add(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
        clients.delete(res);
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
  }

  /**
   * Handle an already-prefix-stripped path. Returns true when the request was
   * answered here.
   */
  function handle(req, res, url, sub) {
    if (!sub.startsWith('/api/')) return false;
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') {
      if (!cors) {
        sendText(res, 403, 'forbidden origin');
        return true;
      }
      sendText(res, 204, '', 'text/plain; charset=utf-8', cors);
      return true;
    }

    switch (sub) {
      case '/api/health':
        sendJson(res, 200, hub.serverInfo(), cors);
        return true;
      case '/api/sessions':
        sendJson(res, 200, {
          active: lastSnapshot?.session?.id || null,
          sessions: listSessions(paths, { limit: 40 }),
        }, cors);
        return true;
      case '/api/state': {
        const snapshot = hub.snapshotFor(url.searchParams.get('session'));
        lastSnapshot = snapshot;
        sendJson(res, 200, snapshot, cors);
        return true;
      }
      case '/api/follow': {
        hub.setFollowing(url.searchParams.get('session'));
        lastSnapshot = tick();
        sendJson(res, 200, { ok: true, following: hub.following || 'auto' }, cors);
        return true;
      }
      case '/api/quota/refresh': {
        // Bar click asks for fresh quota now; the new snapshot is broadcast
        // to every stream client as a side effect.
        Promise.resolve(hub.refreshQuota())
          .catch(() => null)
          .then(() => {
            lastSnapshot = tick();
            sendJson(res, 200, { ok: true, quota: lastSnapshot ? lastSnapshot.quota : null }, cors);
          });
        return true;
      }
      case '/api/stream':
        if (url.searchParams.get('session')) hub.setFollowing(url.searchParams.get('session'));
        openStream(req, res, cors);
        return true;
      default:
        sendText(res, 404, 'not found', 'text/plain; charset=utf-8', cors);
        return true;
    }
  }

  return {
    handle,
    openStream,
    tick,
    broadcast,
    snapshot: () => lastSnapshot,
    clientCount: () => clients.size,
    log,
  };
}
