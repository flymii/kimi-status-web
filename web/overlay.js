// The status bar that lives inside the Kimi Code web UI, delivered as a
// userscript. It renders in a shadow root so it cannot disturb (or be disturbed
// by) the host app, and it follows the session the page is showing.
(() => {
  // Metrics come from the local kimi-status-web server, or from the kimi web
  // REST API when the page is reached over a LAN / proxied origin.
  const PREFIX = window.__KIMI_STATUS_BASE || '/_kimi-status';
  if (window.__kimiStatusOverlay) return;
  window.__kimiStatusOverlay = true;

  // The build matches every origin so it also works on LAN and reverse-proxied
  // deployments; bail out right away anywhere that is not a kimi web page.
  function isKimiWebPage() {
    const host = location.hostname;
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') return true;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return true;
    if (/^\/(sessions|admin)\//.test(location.pathname)) return true;
    try {
      for (const store of [window.localStorage, window.sessionStorage]) {
        if (store.getItem('kimi-web.server-credential')) return true;
      }
    } catch {
      /* storage blocked */
    }
    return Boolean(document.getElementById('app')) && /kimi/i.test(document.title || '');
  }

  // Never decorate our own dashboard page with a second status bar.
  function isOwnPanel() {
    const brand = document.querySelector('header.topbar .brand-name');
    return Boolean(brand && /kimi status/i.test(brand.textContent || ''));
  }

  if (!isKimiWebPage() || isOwnPanel()) return;

  const HOST_ID = 'kimi-status-overlay';
  if (document.getElementById(HOST_ID)) return;

  const state = {
    sessionId: null,
    source: null,
    // ?ksw_poll=1 forces polling and ?ksw_open=1 starts expanded — both are for
    // screenshots, embedding, and debugging.
    expanded: /[?&]ksw_open=1/.test(location.search),
    polling: /[?&]ksw_poll=1/.test(location.search),
    snapshot: null,
    timer: null,
    ticker: null,
  };

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  document.body.appendChild(host);

  // The userscript build bakes the stylesheet in; without it the bar renders
  // unstyled rather than not at all.
  const sheetText = window.__KIMI_STATUS_CSS;
  if (sheetText) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(sheetText);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = sheetText;
      shadow.appendChild(style);
    }
  }

  const root = document.createElement('div');
  root.className = 'ksw';
  root.dataset.live = 'connecting';
  root.dataset.theme = 'dark';
  root.innerHTML = `
    <div class="ksw-card" hidden></div>
    <div class="ksw-bar" role="button" tabindex="0" title="点击展开 / 收起 Kimi 状态">
      <span class="ksw-dot"></span>
      <span class="ksw-chips"></span>
      <span class="ksw-caret">▾</span>
    </div>`;
  shadow.appendChild(root);

  const bar = root.querySelector('.ksw-bar');
  const card = root.querySelector('.ksw-card');
  const chips = root.querySelector('.ksw-chips');
  const caret = root.querySelector('.ksw-caret');
  // Never show an empty pill: the first snapshot replaces this placeholder.
  chips.innerHTML = '<span class="ksw-chip"><span class="label">连接中…</span></span>';

  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const fmtTokens = (value) => {
    if (!Number.isFinite(value)) return '—';
    const abs = Math.abs(value);
    if (abs < 1000) return String(Math.round(value));
    if (abs < 10000) return `${(value / 1000).toFixed(1)}k`;
    if (abs < 1000000) return `${Math.round(value / 1000)}k`;
    return `${(value / 1000000).toFixed(2)}M`;
  };
  const fmtRate = (value) => (!Number.isFinite(value) ? '—' : value < 10 ? value.toFixed(1) : String(Math.round(value)));
  // Near-perfect hit rates get a decimal: rounding 99.7% up to "100%" reads like
  // a bug, and 100% is a meaningful claim that should only appear when true.
  const fmtPercent = (rate) => {
    if (!Number.isFinite(rate)) return '—';
    const pct = Math.max(0, Math.min(1, rate)) * 100;
    if (pct >= 99.95 && pct < 100) return '>99.9%';
    if (pct >= 99 && pct < 100) return `${pct.toFixed(1)}%`;
    if (pct > 0 && pct < 0.1) return '<0.1%';
    return `${Math.round(pct)}%`;
  };
  const fmtDuration = (ms) => {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60000);
    return `${minutes}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`;
  };
  const chip = (label, value, className = '', unit = '') => `<span class="ksw-chip ${className}">`
    + `<span class="label">${esc(label)}</span><span class="value">${esc(value)}</span>`
    + (unit ? `<span class="unit">${esc(unit)}</span>` : '')
    + '</span>';

  /** Session id as the web UI knows it: from the route, then from the app itself. */
  function sessionFromLocation() {
    const sources = [location.pathname || '', location.search || '', location.hash || ''];
    for (const source of sources) {
      const byPath = /\/sessions?\/([A-Za-z0-9_-]{8,})/.exec(source);
      if (byPath) return byPath[1];
      const byId = /((?:session|ses)_[A-Za-z0-9-]{8,})/.exec(source);
      if (byId) return byId[1];
    }
    return sessionFromRouter();
  }

  /** Last resort: the SPA's own router state, for routes that hide the id. */
  function sessionFromRouter() {
    try {
      const mount = document.getElementById('app');
      const app = mount && mount.__vue_app__;
      const globals = app && app.config && app.config.globalProperties;
      const current = globals && globals.$router && globals.$router.currentRoute;
      const route = current && (current.value || current);
      const params = route && route.params;
      if (!params) return null;
      const id = params.id || params.sessionId || params.session;
      return typeof id === 'string' && id.length >= 8 ? id : null;
    } catch {
      return null;
    }
  }

  function renderBar(snapshot) {
    const head = snapshot.headline || {};
    if (!snapshot.session) {
      chips.innerHTML = '<span class="ksw-chip"><span class="label">未找到会话</span>'
        + `<span class="value">${esc(state.sessionId || '自动跟随')}</span></span>`;
      bar.title = '本机 ~/.kimi-code/sessions 里没有这个会话';
      return;
    }
    const parts = [
      chip('入', fmtTokens(head.input)),
      chip('出', fmtTokens(head.output)),
      chip('缓存', fmtPercent(head.cacheRate), 'cache'),
      chip('↑', fmtRate(head.tps), 'tps', 'tok/s'),
      chip('⚡', fmtDuration(head.ttftMs), 'ttft'),
    ];
    chips.innerHTML = parts.join('<span class="ksw-sep">·</span>');
    const cacheLine = Number.isFinite(head.cacheRate)
      ? `缓存命中 ${fmtPercent(head.cacheRate)}：缓存读 ${fmtTokens(head.cacheRead)} / 输入 ${fmtTokens(head.input)}，未缓存 ${fmtTokens(head.inputOther)}`
      : '';
    bar.title = [
      snapshot.session.title || snapshot.session.id,
      snapshot.session.cwd || '',
      `模型 ${head.model || '—'} · 上下文 ${fmtTokens(head.contextTokens)}`,
      cacheLine,
    ].filter(Boolean).join('\n');
  }

  function spark(steps) {
    const values = (steps || []).filter((step) => Number.isFinite(step.tps)).map((step) => step.tps);
    if (values.length < 2) return '';
    const max = Math.max(...values, 1);
    const width = 300;
    const height = 40;
    const stepX = width / (values.length - 1);
    const points = values.map((value, index) => {
      const x = index * stepX;
      const y = height - (value / max) * (height - 6) - 3;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<div class="ksw-spark"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">`
      + `<polyline points="${points}" fill="none" stroke="#4fa8ff" stroke-width="1.4"/></svg></div>`;
  }

  function row(key, value, cls = '') {
    return `<div class="ksw-row"><span class="k">${esc(key)}</span>`
      + `<span class="v ${cls}">${esc(value)}</span></div>`;
  }

  function renderCard(snapshot) {
    if (!state.expanded) {
      card.hidden = true;
      caret.textContent = '▾';
      return;
    }
    const head = snapshot.headline || {};
    const turn = snapshot.turn || {};
    const totals = snapshot.totals || {};
    const agents = (snapshot.agents || []).filter((agent) => agent.name !== 'main' || agent.output);
    const fromApi = snapshot.source === 'api';
    card.hidden = false;
    caret.textContent = '▴';
    const notice = state.online === false
      ? `<div class="ksw-section">
          <div class="ksw-title">状态服务未连接</div>
          ${row('地址', PREFIX)}
          <div class="ksw-prompt">在终端执行：node bin/kimi-status-web.mjs open</div>
        </div>`
      : !snapshot.session
        ? `<div class="ksw-section">
            <div class="ksw-title">没有找到会话</div>
            ${row('请求的会话', state.sessionId || '自动跟随')}
            <div class="ksw-prompt">指标只读本机 ~/.kimi-code/sessions 里的会话日志</div>
          </div>`
        : (snapshot.ui && snapshot.ui.missingSessionId)
          ? `<div class="ksw-section">
              <div class="ksw-title">已回退到最近活跃会话</div>
              ${row('页面里的 ID', snapshot.ui.missingSessionId)}
              <div class="ksw-prompt">本机会话列表里没有这个 ID，当前显示的是最近活跃会话。定位用：${esc(location.href)}</div>
            </div>`
          : !state.sessionId
            ? `<div class="ksw-section">
                <div class="ksw-title">跟随最近活跃会话</div>
                <div class="ksw-prompt">地址里没有会话 ID（首页属正常）。如果这条不是页面上正在看的会话，把下面这行发我：${esc(location.href)}</div>
              </div>`
            : '';
    card.innerHTML = `
      ${notice}
      <div class="ksw-section">
        <div class="ksw-title">${esc((snapshot.ui && snapshot.ui.turnLabel) || '本回合')}</div>
        ${row('状态', turn.running ? '进行中' : '已结束', turn.running ? 'good' : '')}
        ${fromApi ? '' : row('耗时', fmtDuration(head.elapsedMs))}
        ${row('步数 / 工具', `${turn.steps ?? 0} / ${turn.toolCalls ?? 0}`)}
        ${row('首字延迟', fmtDuration(head.ttftMs), 'info')}
        ${row('缓存命中', fmtPercent(turn.cacheRate), 'good')}
        ${row('输入 未缓存/缓存读', `${fmtTokens(head.inputOther)} / ${fmtTokens(head.cacheRead)}`)}
        ${turn.prompt ? `<div class="ksw-prompt">❯ ${esc(turn.prompt)}</div>` : ''}
      </div>
      <div class="ksw-section">
        <div class="ksw-title">吞吐</div>
        ${spark(snapshot.steps)}
        ${row('中位吞吐', Number.isFinite(head.tps) ? `${fmtRate(head.tps)} tok/s` : '—', 'info')}
        ${row('上下文', fmtTokens(head.contextTokens))}
      </div>
      <div class="ksw-section">
        <div class="ksw-title">会话累计</div>
        ${row('入 / 出', `${fmtTokens(totals.input)} / ${fmtTokens(totals.output)}`)}
        ${row('缓存命中率', fmtPercent(totals.cacheRate), 'good')}
        ${row('步数 / 回合', `${totals.steps ?? 0} / ${totals.turns ?? 0}`)}
        ${row('工具调用', String(totals.toolCalls ?? 0))}
      </div>
      ${agents.length ? `<div class="ksw-section ksw-agents">
        <div class="ksw-title">Agent</div>
        ${agents.map((agent) => row(
          `${agent.name}${agent.active ? ' ●' : ''}`,
          `${fmtRate(agent.tps)} tok/s · ${fmtTokens(agent.output)}`,
          agent.active ? 'good' : '',
        )).join('')}
      </div>` : ''}
      <div class="ksw-links">
        ${fromApi ? '' : `<a href="${PREFIX}/" target="_blank" rel="noreferrer">完整面板 ↗</a>`}
        <a data-action="pin">只跟随本会话</a>
        <span style="color:var(--dim)">${esc(fromApi ? `API · ${snapshot.session?.id?.slice(0, 14) || ''}` : snapshot.session?.id?.slice(0, 20) || '')}</span>
      </div>`;

    const pin = card.querySelector('[data-action="pin"]');
    if (pin) {
      pin.addEventListener('click', () => {
        state.sessionId = sessionFromLocation();
        connect();
      });
    }
  }

  function render(snapshot) {
    state.snapshot = snapshot;
    state.online = true;
    setLive('open');
    renderBar(snapshot);
    renderCard(snapshot);
  }

  function setLive(value) {
    root.dataset.live = value;
  }

  const baseLabel = () => {
    try {
      return new URL(PREFIX, location.href).host || PREFIX;
    } catch {
      return PREFIX;
    }
  };

  /** The metrics server did not answer: say so instead of an empty pill. */
  function renderOffline() {
    state.online = false;
    chips.innerHTML = '<span class="ksw-chip"><span class="label">未连接</span>'
      + `<span class="value">${esc(baseLabel())}</span></span>`;
    setLive('closed');
    renderCard(state.snapshot || {});
  }

  // ---- data sources --------------------------------------------------------
  // Preferred: the local metrics service (no token, incremental reads).
  // Fallback: the kimi web REST API itself — same origin as the page, with the
  // bearer token the web UI already stores, so it also works when the instance
  // is reached over a LAN or a public reverse proxy.
  const LOCAL_BASE = PREFIX;
  const API_BASE = '/api/v1';
  const CRED_KEY = 'kimi-web.server-credential';
  const WIRE_TAIL_BYTES = 256 * 1024;
  const INDEX_TAIL_BYTES = 128 * 1024;
  const apiCache = { home: null, dirs: new Map(), meta: new Map() };

  function credentials() {
    const found = [];
    for (const store of [window.localStorage, window.sessionStorage]) {
      try {
        const raw = store.getItem(CRED_KEY);
        if (!raw) continue;
        let token = raw;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.credential === 'string') token = parsed.credential;
        } catch {
          /* stored as a raw token */
        }
        if (token && token.length > 10 && !found.includes(token)) found.push(token);
      } catch {
        /* storage blocked */
      }
    }
    return found;
  }

  /** Same-origin API call; retries without a token for omit-auth deployments. */
  async function apiFetch(path, init = {}) {
    const candidates = credentials().concat([null]);
    let lastError = null;
    let lastResponse = null;
    for (const token of candidates) {
      const headers = { Accept: 'application/json', ...(init.headers || {}) };
      if (token) headers.Authorization = `Bearer ${token}`;
      let response;
      try {
        response = await fetch(path, { ...init, headers, cache: 'no-store' });
      } catch (error) {
        lastError = error;
        continue;
      }
      if (response.status !== 401 && response.status !== 403) return response;
      lastResponse = response;
    }
    if (lastResponse) return lastResponse;
    throw lastError || new Error('api unreachable');
  }

  async function apiJson(path, init) {
    const response = await apiFetch(path, init);
    if (!response.ok) throw new Error(`api ${response.status}`);
    const payload = await response.json().catch(() => null);
    if (!payload || payload.code !== 0 || !payload.data) throw new Error('api payload');
    return payload.data;
  }

  async function apiTail(path, bytes) {
    const response = await apiFetch(path, { headers: { Range: `bytes=-${bytes}` } });
    if (!response.ok && response.status !== 206) return null;
    return response.text();
  }

  async function apiSessionDir(sessionId) {
    if (apiCache.dirs.has(sessionId)) return apiCache.dirs.get(sessionId);
    if (!apiCache.home) {
      const data = await apiJson(`${API_BASE}/fs:home`).catch(() => null);
      if (!data || !data.home) return null;
      apiCache.home = data.home;
    }
    const indexPath = `${apiCache.home.replace(/[\\/]+$/, '')}/.kimi-code/session_index.jsonl`;
    const text = await apiTail(`${API_BASE}/fs:content?path=${encodeURIComponent(indexPath)}`, INDEX_TAIL_BYTES);
    if (!text) return null;
    const line = text.split('\n').reverse().find((row) => row.includes(sessionId));
    const match = line && line.match(/"sessionDir"\s*:\s*"((?:\\.|[^"])*)"/);
    if (!match) return null;
    let dir = null;
    try {
      dir = JSON.parse(`"${match[1]}"`);
    } catch {
      return null;
    }
    apiCache.dirs.set(sessionId, dir);
    return dir;
  }

  async function apiSessionMeta(sessionId) {
    if (apiCache.meta.has(sessionId)) return apiCache.meta.get(sessionId);
    const data = await apiJson(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}`).catch(() => null);
    const meta = data && (data.session || data) || {};
    const value = { title: meta.title || '', cwd: meta.cwd || '' };
    apiCache.meta.set(sessionId, value);
    return value;
  }

  /** Fold the wire tail into steps/tools/context for the panel. */
  function foldWireTail(text, snapshot) {
    const steps = [];
    const tools = [];
    let contextTokens = null;
    for (const line of text.split('\n')) {
      if (!line || line.charCodeAt(0) !== 123) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.type === 'token_counting.measured' && typeof row.tokens === 'number') {
        contextTokens = row.tokens;
        continue;
      }
      if (row.type !== 'context.append_loop_event' || !row.event) continue;
      const event = row.event;
      const agent = row.agentId || 'main';
      if (event.type === 'step.end' && event.usage) {
        const output = event.usage.output || 0;
        const streamMs = event.llmStreamDurationMs || 0;
        const ttftMs = typeof event.llmFirstTokenLatencyMs === 'number'
          ? event.llmFirstTokenLatencyMs
          : null;
        const input = (event.usage.inputOther || 0) + (event.usage.inputCacheRead || 0)
          + (event.usage.inputCacheCreation || 0);
        steps.push({
          time: row.time || null,
          agent,
          output,
          input,
          cacheRead: event.usage.inputCacheRead || 0,
          usage: event.usage,
          ttftMs,
          streamMs,
          tps: streamMs > 0 && output > 0 ? output / (streamMs / 1000) : null,
        });
      } else if (event.type === 'tool.call') {
        tools.push({
          id: event.toolCallId || null,
          name: event.name || 'tool',
          agent,
          time: row.time || null,
          ok: null,
        });
      } else if (event.type === 'tool.result' && event.toolCallId) {
        for (let i = tools.length - 1; i >= 0; i -= 1) {
          if (tools[i].id !== event.toolCallId) continue;
          tools[i].ok = !(event.isError === true
            || (event.result && event.result.isError === true));
          break;
        }
      }
    }

    const last = steps.length ? steps[steps.length - 1] : null;
    snapshot.steps = steps.slice(-60);
    snapshot.tools = tools.slice(-60).reverse();
    snapshot.headline.contextTokens = contextTokens;
    // Totals other than tokens only describe the tail window we could read.
    snapshot.totals.steps = snapshot.steps.length;
    snapshot.totals.toolCalls = snapshot.tools.length;
    if (last) {
      snapshot.headline.tps = last.tps;
      snapshot.headline.ttftMs = last.ttftMs;
      snapshot.headline.lastStepAt = last.time;
      snapshot.turn.usage = last.usage;
      snapshot.turn.input = last.input;
      snapshot.turn.output = last.output;
      snapshot.turn.cacheRate = last.input > 0 ? last.cacheRead / last.input : null;
      snapshot.turn.steps = snapshot.steps.length;
      snapshot.turn.toolCalls = snapshot.tools.length;
    }
    if (snapshot.agents[0]) {
      const agent = snapshot.agents[0];
      agent.tps = last ? last.tps : null;
      agent.ttftMs = last ? last.ttftMs : null;
      agent.contextTokens = contextTokens;
      agent.lastStepAt = last ? last.time : null;
    }
  }

  async function fetchApiSnapshot(sessionId) {
    let id = sessionId;
    if (!id) {
      for (const query of ['busy=true&page_size=5', 'page_size=1']) {
        const data = await apiJson(`${API_BASE}/sessions?${query}`).catch(() => null);
        const items = data && data.items;
        if (items && items.length) {
          id = items[0].id;
          break;
        }
      }
      if (!id) throw new Error('no session');
    }
    const data = await apiJson(`${API_BASE}/sessions/${encodeURIComponent(id)}/snapshot`);
    const session = data.session || data;
    const usage = session.usage || {};
    const inputOther = usage.input_tokens || 0;
    const cacheRead = usage.cache_read_tokens || 0;
    const cacheCreation = usage.cache_creation_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const input = inputOther + cacheRead + cacheCreation;
    const cacheRate = input > 0 ? cacheRead / input : null;
    const meta = await apiSessionMeta(id).catch(() => ({ title: '', cwd: '' }));
    const agentConfig = session.agent_config || {};
    const snapshot = {
      ok: true,
      generatedAt: Date.now(),
      source: 'api',
      ui: { turnLabel: '最近一次请求' },
      session: {
        id,
        title: session.title || meta.title || '',
        cwd: session.cwd || meta.cwd || '',
        branch: null,
        agentCount: 1,
        updatedAt: null,
        activityAt: null,
      },
      headline: {
        input,
        output: outputTokens,
        inputOther,
        cacheRead,
        cacheCreation,
        cacheRate,
        turnCacheRate: null,
        tps: null,
        ttftMs: null,
        elapsedMs: null,
        contextTokens: null,
        model: agentConfig.model || session.model || '',
        thinking: null,
        lastStepAt: null,
      },
      turn: {
        index: usage.turn_count || 0,
        running: session.busy === true,
        startedAt: null,
        endedAt: null,
        prompt: null,
        steps: 0,
        toolCalls: 0,
        usage: {},
        input: 0,
        output: 0,
        cacheRate: null,
      },
      totals: {
        input,
        output: outputTokens,
        cacheRead,
        cacheInput: input,
        cacheRate,
        steps: 0,
        turns: usage.turn_count || 0,
        toolCalls: 0,
        byModel: [],
      },
      agents: [{
        name: 'main',
        model: agentConfig.model || session.model || '',
        thinking: null,
        tps: null,
        ttftMs: null,
        contextTokens: null,
        usage: {},
        input,
        output: outputTokens,
        cacheRate,
        lastStepAt: null,
        active: session.busy === true,
      }],
      steps: [],
      tools: [],
      window: { partial: true, truncated: false, firstRowTime: null, lastRowTime: null },
    };

    const dir = await apiSessionDir(id).catch(() => null);
    if (dir) {
      const wire = `${dir.replace(/[\\/]+$/, '')}/agents/main/wire.jsonl`;
      const tail = await apiTail(`${API_BASE}/fs:content?path=${encodeURIComponent(wire)}`, WIRE_TAIL_BYTES)
        .catch(() => null);
      if (tail) foldWireTail(tail, snapshot);
    }
    return snapshot;
  }

  /** Local metrics service, with a deadline so a black-holed port cannot hang. */
  async function fetchLocalSnapshot(sessionId) {
    const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(2000)
      : undefined;
    const response = await fetch(`${LOCAL_BASE}/api/state${query}`, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`local ${response.status}`);
    const snapshot = await response.json();
    snapshot.source = 'local';
    return snapshot;
  }

  async function loadSnapshot(sessionId) {
    state.polls = (state.polls || 0) + 1;
    // While on the API, occasionally retry the local service in case it came
    // back (or the page moved from a remote proxy to localhost).
    const retryLocal = state.source === 'api' && state.polls % 10 === 0;
    if (state.source !== 'api' || retryLocal) {
      try {
        let snapshot = await fetchLocalSnapshot(sessionId);
        if (sessionId && !snapshot.session) {
          // The id from the page is not one this machine knows: show the most
          // recently active session instead of an empty bar.
          const fallback = await fetchLocalSnapshot(null);
          if (fallback.session) {
            fallback.ui = { ...(fallback.ui || {}), missingSessionId: sessionId };
            snapshot = fallback;
          }
        }
        state.source = 'local';
        return snapshot;
      } catch {
        state.source = 'api';
      }
    }
    try {
      return await fetchApiSnapshot(sessionId);
    } catch (error) {
      if (!sessionId) throw error;
      const fallback = await fetchApiSnapshot(null);
      fallback.ui = { ...(fallback.ui || {}), missingSessionId: sessionId };
      return fallback;
    }
  }

  async function poll() {
    try {
      render(await loadSnapshot(state.sessionId));
    } catch {
      if (!state.sseOpen) renderOffline();
    }
  }

  function startTicker() {
    if (state.ticker) return;
    state.ticker = setInterval(poll, state.polling ? 1500 : 3000);
  }

  function connect() {
    if (state.source) {
      state.source.close();
      state.source = null;
    }
    if (state.ticker) {
      clearInterval(state.ticker);
      state.ticker = null;
    }
    if (state.watchdog) {
      clearTimeout(state.watchdog);
      state.watchdog = null;
    }
    state.sseOpen = false;
    const query = state.sessionId ? `?session=${encodeURIComponent(state.sessionId)}` : '';
    if (state.polling) {
      startTicker();
      poll();
      return;
    }
    try {
      const source = new EventSource(`${PREFIX}/api/stream${query}`);
      state.source = source;
      source.onopen = () => {
        state.sseOpen = true;
        setLive('open');
      };
      source.addEventListener('snapshot', (event) => {
        try {
          render(JSON.parse(event.data));
        } catch {
          /* ignore a malformed frame */
        }
      });
      source.onerror = () => {
        state.sseOpen = false;
        setLive('closed');
        startTicker();
      };
      // A stream that never opens must not leave the bar stuck on "连接中…".
      state.watchdog = setTimeout(() => {
        if (!state.sseOpen) startTicker();
      }, 5000);
    } catch {
      startTicker();
    }
    poll();
  }

  function syncSession() {
    const next = sessionFromLocation();
    if (next === state.sessionId) return;
    state.sessionId = next;
    connect();
  }

  bar.addEventListener('click', () => {
    state.expanded = !state.expanded;
    if (state.snapshot) renderCard(state.snapshot);
  });
  bar.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      state.expanded = !state.expanded;
      if (state.snapshot) renderCard(state.snapshot);
    }
  });

  // The host app is a SPA: watch every way its route can change.
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function patched(...args) {
      const result = original.apply(this, args);
      window.setTimeout(syncSession, 0);
      return result;
    };
  }
  window.addEventListener('popstate', syncSession);
  window.addEventListener('hashchange', syncSession);

  function syncTheme() {
    const pref = document.documentElement.dataset.colorScheme;
    const dark = pref === 'dark'
      || (pref !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = dark ? 'dark' : 'light';
  }
  syncTheme();
  try {
    new MutationObserver(syncTheme).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-color-scheme'],
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme);
  } catch {
    /* older engines */
  }

  // ---- mount: a sibling right after the message composer --------------------
  // The bar is a real element in the page flow, so the composer above it gets
  // pushed up rather than covered. The host app re-renders the composer as you
  // type, which can drop foreign nodes — a cheap watchdog puts it back.
  const COMPOSER_SELECTORS = [
    '.ProseMirror',
    '.ui-textarea',
    '[contenteditable="true"]',
    'textarea',
    '[role="textbox"]',
  ];
  const FALLBACK = { right: 16, bottom: 16 };
  let composerEl = null;
  let boxEl = null;
  let lastCheck = 0;

  function bottomMostVisible(elements) {
    let best = null;
    let bestBottom = -Infinity;
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 8) continue;
      if (rect.bottom > bestBottom) {
        bestBottom = rect.bottom;
        best = el;
      }
    }
    return best;
  }

  function findComposer() {
    if (composerEl && composerEl.isConnected) {
      const rect = composerEl.getBoundingClientRect();
      if (rect.width >= 40 && rect.height >= 8) return composerEl;
    }
    composerEl = null;
    for (const selector of COMPOSER_SELECTORS) {
      const el = bottomMostVisible(document.querySelectorAll(selector));
      if (el) {
        composerEl = el;
        return el;
      }
    }
    return null;
  }

  /** Nearest ancestor drawn as a box: a border or fill, plus some rounding. */
  function findBox(input) {
    let el = input;
    let rect = el.getBoundingClientRect();
    for (let depth = 0; depth < 6 && el.parentElement; depth += 1) {
      const parent = el.parentElement;
      if (parent === document.body) break;
      const parentRect = parent.getBoundingClientRect();
      if (parentRect.width > rect.width + 120) break;
      if (parentRect.height > Math.max(rect.height * 4, 360)) break;
      el = parent;
      rect = parentRect;
      const style = getComputedStyle(parent);
      const borderWidth = parseFloat(style.borderTopWidth)
        + parseFloat(style.borderBottomWidth)
        + parseFloat(style.borderLeftWidth)
        + parseFloat(style.borderRightWidth);
      const background = style.backgroundColor || '';
      const painted = background !== '' && background !== 'transparent'
        && background !== 'rgba(0, 0, 0, 0)';
      const radius = parseFloat(style.borderTopLeftRadius) || 0;
      if ((borderWidth > 0 || painted) && radius > 0) return parent;
    }
    return el;
  }

  /** Already sitting where it belongs, right after the composer box? */
  function anchored() {
    return Boolean(boxEl && boxEl.isConnected && boxEl.parentElement
      && host.parentElement === boxEl.parentElement
      && host.previousElementSibling === boxEl);
  }

  function updateCardOffset() {
    if (!boxEl || !boxEl.isConnected) return;
    const height = Math.round(boxEl.getBoundingClientRect().height);
    // The card opens above the composer, never over the input area.
    root.style.setProperty('--ksw-card-offset', `${Math.max(height + 14, 8)}px`);
  }

  function fallbackPlacement() {
    if (host.parentElement !== document.body) document.body.appendChild(host);
    root.style.position = 'fixed';
    root.style.right = `${FALLBACK.right}px`;
    root.style.bottom = `${FALLBACK.bottom}px`;
    root.style.left = 'auto';
    root.style.top = 'auto';
    root.style.width = 'auto';
    root.style.margin = '0';
    root.style.setProperty('--ksw-card-offset', '8px');
    boxEl = null;
  }

  function mount() {
    if (anchored()) {
      updateCardOffset();
      return;
    }
    const input = findComposer();
    const box = input ? findBox(input) : null;
    if (!box || !box.parentElement) {
      fallbackPlacement();
      return;
    }
    root.style.position = 'relative';
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    root.style.left = 'auto';
    root.style.top = 'auto';
    root.style.width = 'auto';
    root.style.margin = '';
    boxEl = box;
    if (host.parentElement !== box.parentElement || host.previousElementSibling !== box) {
      box.parentElement.insertBefore(host, box.nextSibling);
    }
    updateCardOffset();
  }

  function scheduleMount() {
    const now = Date.now();
    if (now - lastCheck < 300) return;
    lastCheck = now;
    mount();
  }

  state.sessionId = sessionFromLocation();
  connect();
  state.timer = setInterval(syncSession, 4000);
  mount();
  window.addEventListener('resize', scheduleMount);
  setInterval(mount, 1000);
  // The SPA may have captured history.pushState before we patched it, so watch
  // the URL directly too: switching sessions should land within ~0.4s.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    syncSession();
  }, 400);
  try {
    new MutationObserver(() => {
      if (!anchored()) scheduleMount();
    }).observe(document.body, { childList: true, subtree: true });
  } catch {
    /* older engines */
  }
})();
