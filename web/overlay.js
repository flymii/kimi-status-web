// The status bar that lives inside the Kimi Code web UI, delivered as a
// userscript. It renders in a shadow root so it cannot disturb (or be disturbed
// by) the host app, and it follows the session the page is showing.
(() => {
  // Metrics come from the local kimi-status-web server; the userscript build
  // bakes in an absolute base, the plain file defaults to a relative one.
  const PREFIX = window.__KIMI_STATUS_BASE || '/_kimi-status';
  if (window.__kimiStatusOverlay) return;
  window.__kimiStatusOverlay = true;

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
  const fmtPercent = (rate) => (!Number.isFinite(rate) ? '—' : `${Math.round(rate * 100)}%`);
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

  function sessionFromLocation() {
    const match = /\/sessions\/([^/?#]+)/.exec(location.pathname || '');
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
    return null;
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
    bar.title = `${snapshot.session.title || snapshot.session.id}\n`
      + `${snapshot.session.cwd || ''}\n模型 ${head.model || '—'} · 上下文 ${fmtTokens(head.contextTokens)}`;
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
        : '';
    card.innerHTML = `
      ${notice}
      <div class="ksw-section">
        <div class="ksw-title">本回合</div>
        ${row('状态', turn.running ? '进行中' : '已结束', turn.running ? 'good' : '')}
        ${row('耗时', fmtDuration(head.elapsedMs))}
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
        <a href="${PREFIX}/" target="_blank" rel="noreferrer">完整面板 ↗</a>
        <a data-action="pin">只跟随本会话</a>
        <span style="color:var(--dim)">${esc(snapshot.session?.id?.slice(0, 20) || '')}</span>
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

  /** fetch with a deadline, so a black-holed port cannot leave the bar blank. */
  function fetchState(query) {
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(4000)
      : undefined;
    return fetch(`${PREFIX}/api/state${query}`, { signal, cache: 'no-store' });
  }

  async function poll() {
    const query = state.sessionId ? `?session=${encodeURIComponent(state.sessionId)}` : '';
    try {
      const response = await fetchState(query);
      if (!response.ok) throw new Error(`http ${response.status}`);
      render(await response.json());
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
  try {
    new MutationObserver(() => {
      if (!anchored()) scheduleMount();
    }).observe(document.body, { childList: true, subtree: true });
  } catch {
    /* older engines */
  }
})();
