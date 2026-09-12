import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_HOME = os.homedir();

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Resolve every path the tool touches once, so callers never rebuild them. */
export function resolvePaths(env = process.env, home = DEFAULT_HOME) {
  const kimiHome = env.KIMI_CODE_HOME || path.join(home, '.kimi-code');
  const dir = env.KIMI_STATUS_WEB_HOME || path.join(home, '.kimi-status-web');
  return {
    kimiHome,
    dir,
    sessionsRoot: path.join(kimiHome, 'sessions'),
    sessionIndexPath: path.join(kimiHome, 'session_index.jsonl'),
    configPath: path.join(dir, 'config.json'),
    runtimePath: path.join(dir, 'runtime.json'),
    logPath: path.join(dir, 'server.log'),
    webRoot: path.join(PLUGIN_ROOT, 'web'),
  };
}
