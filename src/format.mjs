/** Number formatting shared by the CLI output. */

export function formatTokens(value) {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  if (abs < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (abs < 1000000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1000000).toFixed(2)}M`;
}

export function formatRate(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 10) return value.toFixed(1);
  return String(Math.round(value));
}

export function formatPercent(rate) {
  if (!Number.isFinite(rate)) return '—';
  const pct = Math.max(0, Math.min(1, rate)) * 100;
  if (pct >= 99.95 && pct < 100) return '>99.9%';
  if (pct >= 99 && pct < 100) return `${pct.toFixed(1)}%`;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  return `${Math.round(pct)}%`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

export function formatClock(ms) {
  if (!Number.isFinite(ms)) return '—';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Reset as a compact countdown, e.g. 5h9m / 2d3h. */
export function formatResetIn(ms) {
  if (!Number.isFinite(ms)) return '—';
  const delta = ms - Date.now();
  if (delta <= 0) return '0m';
  const minutes = Math.ceil(delta / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${mins}m`;
  return `${mins}m`;
}

/** The quota period with the least headroom (lowest remaining share). */
/** The most consumed period (highest used share) — that one hits first. */
export function tightestQuotaPeriod(quota) {
  if (!quota || quota.ok !== true || quota.source !== 'kimi') return null;
  const candidates = [quota.weekly, ...(quota.windows || [])]
    .filter((item) => item && Number.isFinite(item.usedPct));
  if (!candidates.length) return null;
  return candidates.reduce((best, item) => (item.usedPct > best.usedPct ? item : best));
}

/** Render one balance entry, e.g. ¥12.44 / $5.00. */
export function formatMoney(balance) {
  if (!balance || !Number.isFinite(balance.total)) return '—';
  const symbols = { CNY: '¥', USD: '$' };
  const symbol = symbols[balance.currency] || `${balance.currency} `;
  return `${symbol}${balance.total.toFixed(2)}`;
}

/** The one-line status row, same shape as a terminal status line. */
export function statusLine(snapshot) {
  const head = snapshot.headline;
  const parts = [
    `入 ${formatTokens(head.input)}`,
    `出 ${formatTokens(head.output)}`,
    `缓存 ${formatPercent(head.cacheRate)}`,
    `↑${formatRate(head.tps)} tok/s`,
    `⚡${formatDuration(head.ttftMs)}`,
  ];
  const quota = snapshot.quota;
  if (quota && quota.ok) {
    if (quota.source === 'deepseek') {
      parts.push(`余额 ${formatMoney(quota.balances && quota.balances[0])}`);
    } else {
      const tight = tightestQuotaPeriod(quota);
      if (tight) {
        parts.push(`已用 ${Math.round(tight.usedPct)}%`, `重置 ${formatResetIn(tight.resetAt)}`);
      }
    }
  }
  return parts.join(' · ');
}
