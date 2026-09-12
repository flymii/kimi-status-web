import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { createMetricsHub } from './hub.mjs';
import { createApiRoutes, corsHeaders, sendText } from './http-api.mjs';
import { clearRuntime, pluginVersion, writeRuntime } from './runtime.mjs';

const STATIC_ROUTES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function hostAllowed(req) {
  const header = req.headers.host;
  if (!header) return true;
  const bare = header.startsWith('[')
    ? header.slice(0, header.indexOf(']') + 1)
    : header.split(':')[0];
  return LOCAL_HOSTS.has(bare);
}

export function serveStatic(paths, res, urlPath, routes = STATIC_ROUTES, extra = null) {
  const route = routes.get(urlPath);
  if (!route) return false;
  const [file, type] = route;
  try {
    const body = fs.readFileSync(path.join(paths.webRoot, file));
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.length,
      'cache-control': 'no-store',
      ...(extra || {}),
    });
    res.end(body);
  } catch {
    sendText(res, 404, 'not found', 'text/plain; charset=utf-8', extra);
  }
  return true;
}

/**
 * The standalone dashboard: serves its own page and API, and follows the most
 * recently active session unless the viewer pins one.
 */
export function createDashboardServer({ paths, config, log = () => {} }) {
  const hub = createMetricsHub({ paths, config, log, mode: 'dashboard' });
  const routes = createApiRoutes({ paths, hub, log });
  let server = null;
  let port = config.port;
  let timer = null;

  function handle(req, res) {
    if (!hostAllowed(req)) {
      sendText(res, 403, 'forbidden host');
      return;
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const cors = corsHeaders(req);
    // The panel answers both at the root and under /_kimi-status/ (the base the
    // userscript uses), so one URL shape works everywhere.
    const mount = '/_kimi-status';
    const pathname = url.pathname === mount
      ? '/'
      : url.pathname.startsWith(`${mount}/`)
        ? url.pathname.slice(mount.length)
        : url.pathname;
    if (routes.handle(req, res, url, pathname)) return;
    if (req.method === 'GET' && serveStatic(paths, res, pathname, STATIC_ROUTES, cors)) return;
    sendText(res, 404, 'not found', 'text/plain; charset=utf-8', cors);
  }

  return {
    get port() {
      return port;
    },
    get url() {
      return `http://127.0.0.1:${port}/`;
    },
    start(assignedPort = config.port) {
      port = assignedPort;
      hub.setPort(port);
      server = http.createServer(handle);
      server.on('error', (error) => log(`server error: ${error && error.message}`));
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          writeRuntime(paths, {
            pid: process.pid,
            port,
            url: `http://127.0.0.1:${port}/`,
            mode: 'dashboard',
            startedAt: Date.now(),
            version: pluginVersion(),
          });
          routes.tick();
          timer = setInterval(() => routes.tick(), config.tickMs);
          if (timer.unref) timer.unref();
          resolve(port);
        });
      });
    },
    stop() {
      if (timer) clearInterval(timer);
      clearRuntime(paths);
      return new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
        return undefined;
      });
    },
    snapshot: () => routes.snapshot(),
  };
}
