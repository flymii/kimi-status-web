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
  return `${Math.round(rate * 100)}%`;
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
  return parts.join(' · ');
}
