#!/usr/bin/env node
// Plugin SessionStart hook: make sure the local metrics server (which the panel
// and the userscript both read from) is running, then get out of the way. It
// never waits for the server to become ready and always exits 0, so a slow disk
// or a busy port can never hold up the session.

import process from 'node:process';

import { loadConfig } from '../src/config.mjs';
import { resolvePaths } from '../src/paths.mjs';
import { findRunning, pickPort, spawnDetached } from '../src/runtime.mjs';

// Drain the hook payload without parsing it; the host must not block on a
// full pipe while we start the server.
try {
  process.stdin.resume();
  process.stdin.on('error', () => {});
} catch {
  /* no stdin payload */
}

try {
  const paths = resolvePaths();
  const config = loadConfig(paths.configPath);
  if (config.autoStart && !(await findRunning(paths, config.port))) {
    const port = (await pickPort(config.port)) || config.port;
    spawnDetached(paths, { port, open: config.openBrowser });
  }
} catch {
  // fail-open: the dashboard is a convenience, never a blocker
}
process.exit(0);
