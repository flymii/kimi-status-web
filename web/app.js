// Dashboard client: subscribes to /api/stream and repaints the panels.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let pinned = params.get('session');
let source = null;
let fallbackTimer = null;
let lastSnapshot = null;

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function fmtTokens(value) {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  if (abs < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (abs < 1000000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1000000).toFixed(2)}M`;
}

function fmtRate(value) {
  if (!Number.isFinite(value)) return '—';
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

function fmtPercent(rate) {
  if (!Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

function fmtClock(ms) {
  if (!Number.isFinite(ms)) return '—';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function fmtAgo(ms) {
  if (!Number.isFinite(ms)) return '—';
  const delta = Date.now() - ms;
  if (delta < 1500) return '刚刚';
  if (delta < 60000) return `${Math.round(delta / 1000)} 秒前`;
  if (delta < 3600000) return `${Math.round(delta / 60000)} 分钟前`;
  return `${Math.round(delta / 3600000)} 小时前`;
}

function chip(label, value, className = '', unit = '') {
  return `<span class="chip ${className}"><span class="label">${escapeHtml(label)}</span>`
    + `<span class="value">${escapeHtml(value)}</span>`
    + (unit ? `<span class="unit">${escapeHtml(unit)}</span>` : '')
    + '</span>';
}

function kvList(target, rows) {
  target.innerHTML = rows
    .map(([label, value, cls]) => `<dt>${escapeHtml(label)}</dt>`
      + `<dd class="${cls || ''}">${value}</dd>`)
    .join('');
}

function renderHero(snapshot) {
  const head = snapshot.headline || {};
  const parts = [
    chip('入', fmtTokens(head.input)),
    chip('出', fmtTokens(head.output)),
    chip('缓存', fmtPercent(head.cacheRate), 'cache'),
    chip('↑', fmtRate(head.tps), 'tps', 'tok/s'),
    chip('⚡', fmtDuration(head.ttftMs), 'ttft'),
  ];
  $('hero-row').innerHTML = parts.join('<span class="sep">·</span>');
  const session = snapshot.session || {};
  const subs = [
    `<span>模型 <b>${escapeHtml(head.model || '—')}</b>${head.thinking ? ` · thinking ${escapeHtml(head.thinking)}` : ''}</span>`,
    `<span>上下文 <b>${fmtTokens(head.contextTokens)}</b></span>`,
    `<span>回合 <b>#${snapshot.turn?.index ?? 0}</b> ${snapshot.turn?.running ? '进行中' : '已结束'}</span>`,
    `<span>耗时 <b>${fmtDuration(head.elapsedMs)}</b></span>`,
    `<span>${escapeHtml(session.title || '未命名会话')}</span>`,
  ];
  $('hero-sub').innerHTML = subs.join('');
}

function renderTurn(snapshot) {
  const turn = snapshot.turn || {};
  const usage = turn.usage || {};
  kvList($('turn-kv'), [
    ['状态', turn.running ? '<span class="good">进行中</span>' : '已结束'],
    ['耗时', fmtDuration(snapshot.headline?.elapsedMs)],
    ['步数', String(turn.steps ?? 0)],
    ['工具调用', String(turn.toolCalls ?? 0)],
    ['首字延迟', fmtDuration(snapshot.headline?.ttftMs), 'info'],
    ['缓存命中', fmtPercent(turn.cacheRate), 'good'],
    ['输入未缓存', fmtTokens(usage.inputOther)],
    ['输入缓存读', fmtTokens(usage.inputCacheRead), 'good'],
    ['输入缓存写', fmtTokens(usage.inputCacheCreation)],
    ['输出', fmtTokens(usage.output)],
  ]);
  $('turn-prompt').textContent = turn.prompt ? `❯ ${turn.prompt}` : '';
  $('turn-prompt').hidden = !turn.prompt;
}

function renderSpark(steps) {
  const points = (steps || []).filter((step) => Number.isFinite(step.tps));
  if (points.length < 2) {
    $('spark').innerHTML = '<p class="empty-hint">等待更多采样…</p>';
    return;
  }
  const values = points.map((step) => step.tps);
  const max = Math.max(...values, 1);
  const width = 300;
  const height = 80;
  const stepX = width / (values.length - 1);
  const coords = values.map((value, index) => {
    const x = index * stepX;
    const y = height - (value / max) * (height - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = coords.join(' ');
  const area = `0,${height} ${line} ${width},${height}`;
  $('spark').innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">`
    + `<defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">`
    + '<stop offset="0%" stop-color="#4fa8ff" stop-opacity="0.35"/>'
    + '<stop offset="100%" stop-color="#4fa8ff" stop-opacity="0"/>'
    + '</linearGradient></defs>'
    + `<polygon points="${area}" fill="url(#fill)"/>`
    + `<polyline points="${line}" fill="none" stroke="#4fa8ff" stroke-width="1.6"/>`
    + '</svg>';
}

function renderSpeed(snapshot) {
  const steps = (snapshot.steps || []).filter((step) => Number.isFinite(step.tps));
  renderSpark(snapshot.steps);
  const values = steps.map((step) => step.tps);
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const outputs = (snapshot.steps || []).map((step) => step.output);
  const avgOutput = outputs.length ? outputs.reduce((a, b) => a + b, 0) / outputs.length : null;
  kvList($('speed-kv'), [
    ['中位吞吐', Number.isFinite(snapshot.headline?.tps) ? `${fmtRate(snapshot.headline.tps)} tok/s` : '—', 'info'],
    ['采样均值', Number.isFinite(avg) ? `${fmtRate(avg)} tok/s` : '—'],
    ['采样数', String(values.length)],
    ['平均输出/步', Number.isFinite(avgOutput) ? `${fmtTokens(avgOutput)} tok` : '—'],
    ['最近一步', fmtAgo(snapshot.headline?.lastStepAt)],
  ]);
}

function renderTotals(snapshot) {
  const totals = snapshot.totals || {};
  kvList($('total-kv'), [
    ['输入合计', fmtTokens(totals.input)],
    ['输出合计', fmtTokens(totals.output)],
    ['缓存读', fmtTokens(totals.cacheRead), 'good'],
    ['缓存命中率', fmtPercent(totals.cacheRate), 'good'],
    ['步数', String(totals.steps ?? 0)],
    ['回合数', String(totals.turns ?? 0)],
    ['工具调用', String(totals.toolCalls ?? 0)],
  ]);
  const rows = (totals.byModel || []).map((entry) => `<tr><td>${escapeHtml(entry.model)}</td>`
    + `<td class="num">${fmtTokens(entry.input)}</td>`
    + `<td class="num">${fmtTokens(entry.output)}</td>`
    + `<td class="num">${entry.calls}</td></tr>`);
  $('model-table').querySelector('tbody').innerHTML = rows.join('')
    || '<tr><td colspan="4" class="muted">暂无调用</td></tr>';
}

function renderAgents(snapshot) {
  const rows = (snapshot.agents || []).map((agent) => `<tr>`
    + `<td>${escapeHtml(agent.name)}${agent.active ? ' <span class="good">●</span>' : ''}</td>`
    + `<td class="muted">${escapeHtml((agent.model || '—').split('/').pop())}</td>`
    + `<td class="num">${fmtRate(agent.tps)}</td>`
    + `<td class="num">${fmtDuration(agent.ttftMs)}</td>`
    + `<td class="num">${fmtTokens(agent.contextTokens)}</td>`
    + `<td class="num">${fmtTokens(agent.output)}</td></tr>`);
  $('agent-table').querySelector('tbody').innerHTML = rows.join('')
    || '<tr><td colspan="6" class="muted">暂无 agent</td></tr>';
}

function renderTools(snapshot) {
  const rows = (snapshot.tools || []).slice(0, 30).map((tool) => {
    const state = tool.ok === true
      ? '<span class="state ok">完成</span>'
      : tool.ok === false
        ? '<span class="state bad">失败</span>'
        : '<span class="state">进行中</span>';
    return `<li><span class="time">${fmtClock(tool.time)}</span>`
      + `<span class="agent">${escapeHtml(tool.agent)}</span>`
      + `<span class="name">${escapeHtml(tool.name)}</span>${state}</li>`;
  });
  $('tool-feed').innerHTML = rows.join('') || '<li class="muted">暂无工具调用</li>';
}

function renderSteps(snapshot) {
  const steps = (snapshot.steps || []).slice(-40).reverse();
  $('steps-card').hidden = steps.length === 0;
  const rows = steps.map((step) => `<tr>`
    + `<td class="muted">${fmtClock(step.time)}</td>`
    + `<td>${escapeHtml(step.agent)}</td>`
    + `<td class="num">${fmtTokens(step.input)}</td>`
    + `<td class="num">${fmtTokens(step.cacheRead)}</td>`
    + `<td class="num">${fmtTokens(step.output)}</td>`
    + `<td class="num">${fmtRate(step.tps)}</td>`
    + `<td class="num">${fmtDuration(step.ttftMs)}</td>`
    + `<td class="num">${fmtDuration(step.streamMs)}</td></tr>`);
  $('step-table').querySelector('tbody').innerHTML = rows.join('');
}

function renderSession(snapshot) {
  const session = snapshot.session || {};
  kvList($('session-kv'), [
    ['标题', escapeHtml(session.title || '—')],
    ['工作目录', `<span title="${escapeHtml(session.cwd)}">${escapeHtml(shortPath(session.cwd))}</span>`],
    ['Git 分支', escapeHtml(session.branch || '—')],
    ['Agent 数', String(session.agentCount ?? 0)],
    ['会话 ID', `<span title="${escapeHtml(session.id)}">${escapeHtml(String(session.id || '').slice(0, 18))}…</span>`],
    ['最后活动', fmtAgo(session.activityAt)],
    ['统计窗口', snapshot.window?.partial ? '<span class="warn">日志尾部</span>' : '全程'],
  ]);
}

function shortPath(value) {
  if (!value) return '—';
  return value.length > 42 ? `…${value.slice(-41)}` : value;
}

function renderFooter(snapshot) {
  const server = snapshot.server || {};
  const parts = [
    `服务 http://127.0.0.1:${server.port}/ · pid ${server.pid}`,
    `运行 ${fmtDuration(server.uptimeMs)}`,
    `刷新 ${(server.tickMs || 0) / 1000}s`,
    `快照 ${fmtClock(snapshot.generatedAt)}`,
  ];
  if (pinned) parts.push(`已固定会话 · <a href="/">回到跟随模式</a>`);
  else parts.push('跟随最近会话');
  $('footer').innerHTML = parts.map((part) => `<span>${part}</span>`).join('');
}

function render(snapshot) {
  lastSnapshot = snapshot;
  const empty = !snapshot.session;
  $('empty').hidden = !empty;
  $('grid').hidden = empty;
  $('hero-row').parentElement.hidden = empty;
  if (empty) {
    $('footer').innerHTML = '没有会话可显示。';
    return;
  }
  renderHero(snapshot);
  renderTurn(snapshot);
  renderSpeed(snapshot);
  renderTotals(snapshot);
  renderAgents(snapshot);
  renderTools(snapshot);
  renderSteps(snapshot);
  renderSession(snapshot);
  renderFooter(snapshot);
}

function setLive(state, text) {
  $('live').dataset.state = state;
  $('live-text').textContent = text;
}

async function loadSessions() {
  try {
    const response = await fetch('api/sessions');
    const data = await response.json();
    const select = $('session-select');
    const current = pinned || data.active || '';
    const options = [`<option value="auto">跟随最近会话</option>`];
    for (const session of data.sessions || []) {
      const label = `${session.title || '(未命名)'} · ${fmtAgo(session.activityAt)}`;
      options.push(`<option value="${escapeHtml(session.id)}"${session.id === current ? ' selected' : ''}>`
        + `${escapeHtml(label)}</option>`);
    }
    select.innerHTML = options.join('');
    select.value = current || 'auto';
  } catch {
    setLive('error', '会话列表不可用');
  }
}

async function pollOnce() {
  try {
    const query = pinned ? `?session=${encodeURIComponent(pinned)}` : '';
    const response = await fetch(`api/state${query}`);
    render(await response.json());
  } catch {
    setLive('error', '连接失败');
  }
}

function connect() {
  if (source) source.close();
  const query = pinned ? `?session=${encodeURIComponent(pinned)}` : '';
  if (params.get('stream') === '0') {
    // Polling mode: for screenshots, print, or proxies that break SSE.
    setLive('closed', '轮询');
    pollOnce();
    if (!fallbackTimer) fallbackTimer = setInterval(pollOnce, 1500);
    return;
  }
  source = new EventSource(`api/stream${query}`);
  source.onopen = () => {
    setLive('open', '实时');
    if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
  };
  source.addEventListener('snapshot', (event) => {
    try {
      render(JSON.parse(event.data));
    } catch {
      /* ignore malformed frame */
    }
  });
  source.onerror = () => {
    setLive('closed', '重连中');
    if (!fallbackTimer) fallbackTimer = setInterval(pollOnce, 3000);
  };
}

$('session-select').addEventListener('change', (event) => {
  const value = event.target.value;
  pinned = value === 'auto' ? null : value;
  const url = new URL(location.href);
  if (pinned) url.searchParams.set('session', pinned);
  else url.searchParams.delete('session');
  history.replaceState(null, '', url);
  connect();
});

$('refresh').addEventListener('click', async () => {
  await loadSessions();
  await pollOnce();
});

loadSessions();
connect();
setInterval(() => {
  if (lastSnapshot) renderFooter(lastSnapshot);
}, 1000);
