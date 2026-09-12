import fs from 'node:fs';

export const DEFAULT_CONFIG = {
  port: 8710,
  autoStart: true,
  openBrowser: false,
  tickMs: 700,
  follow: 'auto',
  keepSessions: 6,
};

function cleanPort(value, fallback = DEFAULT_CONFIG.port) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function cleanTick(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= 200 && ms <= 10000 ? Math.round(ms) : DEFAULT_CONFIG.tickMs;
}

export function normalizeConfig(raw) {
  const config = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== 'object') return config;
  config.port = cleanPort(raw.port);
  config.tickMs = cleanTick(raw.tickMs);
  config.autoStart = raw.autoStart !== false;
  config.openBrowser = raw.openBrowser === true;
  config.follow = typeof raw.follow === 'string' && raw.follow ? raw.follow : 'auto';
  const keep = Number(raw.keepSessions);
  config.keepSessions = Number.isInteger(keep) && keep >= 1 && keep <= 32
    ? keep
    : DEFAULT_CONFIG.keepSessions;
  return config;
}

export function loadConfig(configPath) {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Selection order: CLI flag > environment > config file > built-in default. */
export function effectivePort(paths, cliPort) {
  if (cliPort) return cleanPort(cliPort);
  if (process.env.KIMI_STATUS_WEB_PORT) return cleanPort(process.env.KIMI_STATUS_WEB_PORT);
  return loadConfig(paths.configPath).port;
}
