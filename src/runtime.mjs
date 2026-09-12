import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { PLUGIN_ROOT } from './paths.mjs';

export const CLI_PATH = path.join(PLUGIN_ROOT, 'bin', 'kimi-status-web.mjs');
export const PORT_ATTEMPTS = 10;

export function readRuntime(paths, file = paths.runtimePath) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

export function writeRuntime(paths, data, file = paths.runtimePath) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // A read-only home must not stop the server from running.
  }
}

export function clearRuntime(paths, pid = process.pid, file = paths.runtimePath) {
  const current = readRuntime(paths, file);
  if (current && current.pid !== pid) return;
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

/** Ask a port whether the metrics server is already listening. */
export function probe(port, { host = '127.0.0.1', timeoutMs = 400 } = {}) {
  return new Promise((resolve) => {
    const request = http.get(
      { host, port, path: '/api/health', timeout: timeoutMs },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(data && data.name === 'kimi-status-web' ? data : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on('timeout', () => { request.destroy(); resolve(null); });
    request.on('error', () => resolve(null));
  });
}

export function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

export async function findRunning(paths, preferredPort) {
  const candidates = [];
  if (preferredPort) candidates.push(preferredPort);
  const runtime = readRuntime(paths);
  if (runtime && Number.isInteger(runtime.port) && !candidates.includes(runtime.port)) {
    candidates.push(runtime.port);
  }
  if (!preferredPort && !runtime) return null;
  for (const port of candidates) {
    const health = await probe(port);
    if (health) return { port, health, runtime };
  }
  return null;
}

export async function pickPort(preferred) {
  for (let offset = 0; offset < PORT_ATTEMPTS; offset += 1) {
    const port = preferred + offset;
    if (port > 65535) break;
    // eslint-disable-next-line no-await-in-loop
    if (await portFree(port)) return port;
  }
  return 0;
}

/** Start a server detached from the current process and let it outlive us. */
export function spawnDetached(paths, { port, open = false, cwd = process.cwd(), command = 'serve' } = {}) {
  const args = [CLI_PATH, command];
  if (port) args.push('--port', String(port));
  if (open) args.push('--open');
  let output = 'ignore';
  try {
    fs.mkdirSync(paths.dir, { recursive: true });
    output = fs.openSync(paths.logPath, 'a');
  } catch {
    output = 'ignore';
  }
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', output, output],
    cwd,
    windowsHide: true,
    env: { ...process.env, KIMI_STATUS_WEB_HOME: paths.dir },
  });
  child.unref();
  return child.pid;
}

/**
 * Make sure a dashboard is reachable. Returns the port in use; starts a
 * detached server when none is running.
 */
export async function ensureServer(paths, { port: preferred, open = false } = {}) {
  const running = await findRunning(paths, preferred);
  if (running) return { port: running.port, started: false, pid: running.health.pid };

  const port = await pickPort(preferred || 8710);
  if (!port) throw new Error('no free port available');
  const pid = spawnDetached(paths, { port, open });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
    // eslint-disable-next-line no-await-in-loop
    const health = await probe(port);
    if (health) return { port, started: true, pid: health.pid || pid };
  }
  throw new Error('server did not become ready');
}

export function openBrowser(url) {
  const platform = process.platform;
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function stopServer(paths, file = paths.runtimePath) {
  const runtime = readRuntime(paths, file);
  const pid = runtime && runtime.pid;
  if (!pidAlive(pid)) {
    clearRuntime(paths, pid, file);
    return false;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  clearRuntime(paths, pid, file);
  return true;
}

export function pluginVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export { fileURLToPath };
