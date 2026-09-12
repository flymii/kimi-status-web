import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

/**
 * Account quota behind the dashboard, routed by the model a session is
 * actually calling: the managed kimi-code provider reports weekly allowance /
 * rolling 5-hour window / Extra Usage through the kimi web server's own
 * endpoint (`GET /api/v1/oauth/usage`), while DeepSeek reports a plain
 * balance (`GET /api.deepseek.com/user/balance`) with the key from
 * config.toml. Providers without a balance endpoint (ark, ...) yield no
 * quota block and the UI hides the section.
 */

const REFRESH_MS = 8 * 1000;
const PROVIDERS_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?\/?$/i;

const UNIT_LABELS = {
  minute: 'm',
  hour: 'h',
  day: 'd',
};

function windowLabel(window) {
  if (!window || !Number.isFinite(Number(window.duration))) return '';
  // Weeks read better as days: 7d instead of 1周.
  if (window.unit === 'week') return `${Number(window.duration) * 7}d`;
  const unit = UNIT_LABELS[window.unit] || (window.unit ? String(window.unit) : '');
  return `${window.duration}${unit}`;
}

/** One quota period (weekly summary or a rolling limit window). */
function period(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const used = Number(entry.used);
  const limit = Number(entry.limit);
  const resetAt = Date.parse(entry.reset_at || '');
  const usedPct = Number.isFinite(used) && Number.isFinite(limit) && limit > 0
    ? Math.max(0, Math.min(100, (used / limit) * 100))
    : null;
  return {
    window: windowLabel(entry.window),
    used: Number.isFinite(used) ? used : null,
    limit: Number.isFinite(limit) ? limit : null,
    usedPct,
    remaining: Number.isFinite(usedPct) ? Math.max(0, 100 - usedPct) : null,
    resetAt: Number.isFinite(resetAt) ? resetAt : null,
  };
}

/** `{kind, summary, limits, extra_usage}` (snake_case) -> normalized quota. */
export function normalizeQuota(data, fetchedAt = Date.now()) {
  if (!data || typeof data !== 'object' || data.kind !== 'ok') {
    return { ok: false, fetchedAt };
  }
  const extra = data.extra_usage && typeof data.extra_usage === 'object'
    ? {
      balanceCents: Number.isFinite(Number(data.extra_usage.balance_cents))
        ? Number(data.extra_usage.balance_cents)
        : null,
      totalCents: Number.isFinite(Number(data.extra_usage.total_cents))
        ? Number(data.extra_usage.total_cents)
        : null,
    }
    : null;
  return {
    ok: true,
    source: 'kimi',
    fetchedAt,
    weekly: period(data.summary),
    windows: Array.isArray(data.limits) ? data.limits.map(period).filter(Boolean) : [],
    extra,
  };
}

/** `{is_available, balance_infos}` -> normalized balance. */
export function normalizeBalance(data, fetchedAt = Date.now()) {
  const infos = data && Array.isArray(data.balance_infos) ? data.balance_infos : [];
  const balances = infos
    .map((info) => ({
      currency: typeof info.currency === 'string' ? info.currency : '',
      total: Number(info.total_balance),
      granted: Number(info.granted_balance),
      toppedUp: Number(info.topped_up_balance),
    }))
    .filter((info) => info.currency && Number.isFinite(info.total));
  if (!balances.length) return { ok: false, fetchedAt };
  return {
    ok: true,
    source: 'deepseek',
    label: 'DeepSeek',
    available: data.is_available !== false,
    fetchedAt,
    balances,
  };
}

/** The most consumed period (highest used share) — that one hits first. */
export function tightestPeriod(quota) {
  if (!quota || quota.ok !== true || quota.source !== 'kimi') return null;
  const candidates = [quota.weekly, ...(quota.windows || [])]
    .filter((item) => item && Number.isFinite(item.usedPct));
  if (!candidates.length) return null;
  return candidates.reduce((best, item) => (item.usedPct > best.usedPct ? item : best));
}

// ---- provider table --------------------------------------------------------

/** Where the kimi web server lives and how to authenticate to it. */
function resolveKimiWeb(kimiHome) {
  let origin = null;
  try {
    const rc = JSON.parse(fs.readFileSync(path.join(kimiHome, 'server', 'rc.json'), 'utf8'));
    if (rc && typeof rc.local_origin === 'string') origin = rc.local_origin;
  } catch {
    /* kimi web not running (yet) */
  }
  if (!origin || !LOOPBACK_ORIGIN.test(origin)) return null;
  let token = '';
  try {
    token = fs.readFileSync(path.join(kimiHome, 'server.token'), 'utf8').trim();
  } catch {
    /* no token file */
  }
  if (!token) return null;
  return { origin: origin.replace(/\/+$/, ''), token };
}

function unquoteToml(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return trimmed;
}

/** Split a TOML section header into parts, honoring quoted segments. */
function splitTomlHeader(inner) {
  const parts = [];
  const re = /"((?:\\.|[^"])*)"|[^.]+/g;
  let match;
  while ((match = re.exec(inner))) parts.push(match[1] !== undefined ? match[1] : match[0].trim());
  return parts;
}

/**
 * Provider table from config.toml: enough of a TOML reader for
 * `[providers.<id>]` sections (type / base_url / api_key). Keys stay in
 * memory only and are never logged.
 */
function parseConfigProviders(kimiHome) {
  let text;
  try {
    text = fs.readFileSync(path.join(kimiHome, 'config.toml'), 'utf8');
  } catch {
    return [];
  }
  const providers = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const parts = splitTomlHeader(trimmed.slice(1, -1));
      current = parts[0] === 'providers' && parts[1]
        ? { id: parts[1], type: '', baseUrl: '', apiKey: '' }
        : null;
      if (current) providers.push(current);
      continue;
    }
    if (!current) continue;
    const match = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (!match) continue;
    const value = unquoteToml(match[2]);
    if (match[1] === 'type') current.type = value;
    else if (match[1] === 'base_url') current.baseUrl = value;
    else if (match[1] === 'api_key') current.apiKey = value;
  }
  return providers;
}

function getJson(url, headers = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve(null);
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const request = lib.get(parsed, { headers, timeout: timeoutMs }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
    request.on('error', () => resolve(null));
  });
}

/**
 * Provider table keyed by id, with models and keys merged from the live kimi
 * web server when reachable and config.toml otherwise / additionally.
 */
async function loadProviders(kimiHome, kimiWeb) {
  const fromConfig = parseConfigProviders(kimiHome);
  const byId = new Map(fromConfig.map((provider) => [provider.id, { ...provider, models: [] }]));
  if (kimiWeb) {
    const payload = await getJson(new URL('/api/v1/providers', kimiWeb.origin), {
      authorization: `Bearer ${kimiWeb.token}`,
      accept: 'application/json',
    });
    const items = payload && payload.code === 0 && Array.isArray(payload.data && payload.data.items)
      ? payload.data.items
      : [];
    for (const item of items) {
      if (!item || typeof item.id !== 'string') continue;
      const existing = byId.get(item.id) || { id: item.id, type: '', baseUrl: '', apiKey: '' };
      existing.type = item.type || existing.type;
      existing.baseUrl = item.base_url || existing.baseUrl;
      existing.models = Array.isArray(item.models) ? item.models : [];
      byId.set(item.id, existing);
    }
  }
  return [...byId.values()];
}

/** Map a session's model alias ("deepseek/deepseek-v4-flash") to its provider. */
function matchProvider(providers, model) {
  if (!model || typeof model !== 'string') return null;
  const byModel = providers.find((provider) => provider.models.includes(model));
  if (byModel) return byModel;
  const prefix = model.split('/')[0];
  return providers.find((provider) => provider.id === prefix
    || provider.id === `managed:${prefix}`) || null;
}

function isKimiProvider(provider) {
  return provider.type === 'kimi' || provider.id === 'managed:kimi-code'
    || /(^|\.)kimi\.(com|ai)/i.test(provider.baseUrl);
}

function isDeepSeekProvider(provider) {
  return provider.id === 'deepseek' || /deepseek\.com/i.test(provider.baseUrl);
}

// ---- provider --------------------------------------------------------------

export function createQuotaProvider({ paths, ttlMs = REFRESH_MS } = {}) {
  let current = null;
  let lastModel = null;
  let lastFetch = 0;
  let inflight = null;
  let providers = [];
  let providersAt = 0;

  async function fetchOnce(model) {
    const fetchedAt = Date.now();
    const kimiWeb = resolveKimiWeb(paths.kimiHome);
    if (Date.now() - providersAt > PROVIDERS_TTL_MS || !providers.length) {
      providers = await loadProviders(paths.kimiHome, kimiWeb);
      providersAt = Date.now();
    }
    const provider = matchProvider(providers, model);
    if (!provider) return { ok: false, reason: 'no-provider', model, fetchedAt };
    if (isKimiProvider(provider)) {
      if (!kimiWeb) return { ok: false, reason: 'no-server', model, fetchedAt };
      const payload = await getJson(new URL('/api/v1/oauth/usage', kimiWeb.origin), {
        authorization: `Bearer ${kimiWeb.token}`,
        accept: 'application/json',
      });
      if (payload && payload.code === 0 && payload.data) {
        return { ...normalizeQuota(payload.data), model };
      }
      return { ok: false, reason: 'payload', model, fetchedAt };
    }
    if (isDeepSeekProvider(provider)) {
      if (!provider.apiKey) return { ok: false, reason: 'no-key', model, fetchedAt };
      const payload = await getJson('https://api.deepseek.com/user/balance', {
        authorization: `Bearer ${provider.apiKey}`,
        accept: 'application/json',
      }, 8000);
      if (payload && Array.isArray(payload.balance_infos)) {
        return { ...normalizeBalance(payload), model };
      }
      return { ok: false, reason: 'payload', model, fetchedAt };
    }
    return { ok: false, reason: 'unsupported', model, fetchedAt };
  }

  function touch(model) {
    const now = Date.now();
    if (inflight) return inflight;
    if (!model) return Promise.resolve(current);
    if (current && model === lastModel && now - lastFetch < ttlMs) {
      return Promise.resolve(current);
    }
    lastModel = model;
    lastFetch = now;
    inflight = fetchOnce(model).then((result) => {
      current = result;
      inflight = null;
      return current;
    });
    return inflight;
  }

  return {
    view: () => current,
    touch,
    /** Bypass the TTL (CLI one-shots want fresh data). */
    refresh: (model) => {
      lastFetch = 0;
      return touch(model);
    },
    /** Force-refresh whatever model was last seen (bar click). */
    refreshLast: () => {
      lastFetch = 0;
      return touch(lastModel);
    },
  };
}

/** One-shot fetch for the CLI; null when quota cannot be read. */
export async function fetchQuota(paths, model) {
  const provider = createQuotaProvider({ paths });
  const result = await provider.refresh(model);
  return result && result.ok ? result : null;
}
