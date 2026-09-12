/**
 * Folds Kimi Code wire-journal rows into the live metrics shown by the
 * dashboard. The journal is the only data source: one `usage.record` and one
 * `step.end` per model call, plus turn and tool lifecycle rows.
 */

export const SAMPLE_WINDOW_MS = 5 * 60 * 1000;
export const MAX_SAMPLES = 24;
export const MAX_STEPS = 60;
export const MAX_TOOLS = 60;
const MAX_TRACKED_TOOLS = 400;
const MIN_STREAM_MS = 50;
const MAX_TPS = 5000;

export const USAGE_FIELDS = ['inputOther', 'inputCacheRead', 'inputCacheCreation', 'output'];

export function emptyTokens() {
  return { inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 0 };
}

export function inputTotal(tokens) {
  if (!tokens) return 0;
  return tokens.inputOther + tokens.inputCacheRead + tokens.inputCacheCreation;
}

function validTokens(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const field of USAGE_FIELDS) {
    const count = value[field];
    if (!Number.isFinite(count) || count < 0) return null;
    out[field] = count;
  }
  return out;
}

function addTokens(target, usage) {
  for (const field of USAGE_FIELDS) target[field] += usage[field];
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function createMetricsState() {
  return {
    agents: new Map(),
    turn: {
      index: 0,
      startedAt: null,
      endedAt: null,
      prompt: null,
      steps: 0,
      toolCalls: 0,
      usage: emptyTokens(),
      cache: { readTokens: 0, inputTokens: 0 },
    },
    totals: {
      byModel: new Map(),
      cache: { readTokens: 0, inputTokens: 0 },
      steps: 0,
      turns: 0,
      toolCalls: 0,
    },
    steps: [],
    tools: [],
    truncated: false,
    firstRowTime: null,
    lastRowTime: null,
  };
}

function agentBucket(state, name) {
  let bucket = state.agents.get(name);
  if (!bucket) {
    bucket = {
      name,
      model: null,
      thinking: null,
      samples: [],
      lastStep: null,
      lastRequestAt: null,
      lastStepEndAt: null,
      lastTtftMs: null,
      contextTokens: 0,
      usage: emptyTokens(),
      cache: { readTokens: 0, inputTokens: 0 },
    };
    state.agents.set(name, bucket);
  }
  return bucket;
}

function modelBucket(state, model) {
  let bucket = state.totals.byModel.get(model);
  if (!bucket) {
    bucket = { model, tokens: emptyTokens(), calls: 0 };
    state.totals.byModel.set(model, bucket);
  }
  return bucket;
}

function markActivity(state, row) {
  const time = Number.isFinite(row?.time) ? row.time : null;
  if (time === null) return null;
  if (state.firstRowTime === null || time < state.firstRowTime) state.firstRowTime = time;
  if (state.lastRowTime === null || time > state.lastRowTime) state.lastRowTime = time;
  return time;
}

function foldStepEnd(state, bucket, event, time, agent) {
  const usage = validTokens(event.usage);
  if (!usage) return;
  const output = usage.output;
  const streamMs = Number.isFinite(event.llmStreamDurationMs) ? event.llmStreamDurationMs : 0;
  const ttftMs = Number.isFinite(event.llmFirstTokenLatencyMs) ? event.llmFirstTokenLatencyMs : null;
  const tps = streamMs >= MIN_STREAM_MS && output > 0 ? output / (streamMs / 1000) : null;

  const input = inputTotal(usage);
  bucket.cache.readTokens += usage.inputCacheRead;
  bucket.cache.inputTokens += input;
  state.totals.cache.readTokens += usage.inputCacheRead;
  state.totals.cache.inputTokens += input;
  state.totals.steps += 1;
  bucket.lastStepEndAt = time ?? bucket.lastStepEndAt;
  if (ttftMs !== null) bucket.lastTtftMs = ttftMs;

  if (agent === 'main') {
    state.turn.cache.readTokens += usage.inputCacheRead;
    state.turn.cache.inputTokens += input;
  }

  const step = {
    time,
    agent,
    model: bucket.model,
    output,
    input,
    cacheRead: usage.inputCacheRead,
    ttftMs,
    streamMs,
    tps: tps !== null && tps <= MAX_TPS ? tps : null,
    finishReason: event.finishReason || null,
  };
  bucket.lastStep = step;
  if (step.tps !== null && time !== null) {
    const fresh = bucket.samples.filter((sample) => sample.t >= time - SAMPLE_WINDOW_MS);
    fresh.push({ v: step.tps, t: time });
    bucket.samples = fresh.slice(-MAX_SAMPLES);
  }
  state.steps.push(step);
  if (state.steps.length > MAX_STEPS) state.steps.splice(0, state.steps.length - MAX_STEPS);
}

function foldLoopEvent(state, row, time, agent) {
  const event = row.event;
  if (!event || typeof event.type !== 'string') return;
  const bucket = agentBucket(state, agent);
  switch (event.type) {
    case 'step.begin': {
      if (agent === 'main') state.turn.steps += 1;
      break;
    }
    case 'step.end': {
      foldStepEnd(state, bucket, event, time, agent);
      break;
    }
    case 'tool.call': {
      const tool = {
        id: typeof event.toolCallId === 'string' ? event.toolCallId : null,
        name: typeof event.name === 'string' ? event.name : 'tool',
        agent,
        time,
        ok: null,
      };
      state.totals.toolCalls += 1;
      if (agent === 'main') state.turn.toolCalls += 1;
      state.tools.push(tool);
      if (state.tools.length > MAX_TRACKED_TOOLS) {
        state.tools.splice(0, state.tools.length - MAX_TRACKED_TOOLS);
      }
      break;
    }
    case 'tool.result': {
      const id = typeof event.toolCallId === 'string' ? event.toolCallId : null;
      if (!id) return;
      for (let i = state.tools.length - 1; i >= 0; i -= 1) {
        if (state.tools[i].id !== id) continue;
        const failure = event.isError === true
          || event.is_error === true
          || (event.result && typeof event.result === 'object' && event.result.isError === true);
        state.tools[i].ok = !failure;
        break;
      }
      break;
    }
    default:
      break;
  }
}

function foldRow(state, row, agentName) {
  const agent = typeof row.agentId === 'string' && row.agentId ? row.agentId : agentName;
  const time = markActivity(state, row);
  const bucket = agentBucket(state, agent);

  switch (row.type) {
    case 'llm.request': {
      if (typeof row.modelAlias === 'string' && row.modelAlias) bucket.model = row.modelAlias;
      else if (typeof row.model === 'string' && row.model) bucket.model = row.model;
      if (typeof row.thinkingEffort === 'string' && row.thinkingEffort) {
        bucket.thinking = row.thinkingEffort;
      }
      if (row.kind !== 'compaction' && time !== null) bucket.lastRequestAt = time;
      break;
    }
    case 'usage.record': {
      const usage = validTokens(row.usage);
      if (!usage) return;
      const model = typeof row.model === 'string' && row.model ? row.model : 'unknown';
      const total = modelBucket(state, model);
      addTokens(total.tokens, usage);
      total.calls += 1;
      addTokens(bucket.usage, usage);
      if (state.turn.startedAt === null || (time !== null && time >= state.turn.startedAt)) {
        addTokens(state.turn.usage, usage);
      }
      break;
    }
    case 'turn.prompt': {
      if (agent !== 'main') return;
      state.turn.index += 1;
      state.turn.startedAt = time ?? Date.now();
      state.turn.endedAt = null;
      state.turn.steps = 0;
      state.turn.toolCalls = 0;
      state.turn.usage = emptyTokens();
      state.turn.cache = { readTokens: 0, inputTokens: 0 };
      state.turn.prompt = promptText(row);
      state.totals.turns += 1;
      break;
    }
    case 'turn.ended':
    case 'turn.cancel': {
      if (row.type === 'turn.cancel' && row.target === 'queued') return;
      if (agent !== 'main') return;
      if (time !== null) state.turn.endedAt = time;
      break;
    }
    case 'token_counting.measured': {
      if (Number.isFinite(row.tokens)) bucket.contextTokens = row.tokens;
      break;
    }
    case 'token_counting.truncated': {
      state.truncated = true;
      break;
    }
    case 'context.append_loop_event': {
      foldLoopEvent(state, row, time, agent);
      break;
    }
    default:
      break;
  }
}

function promptText(row) {
  const input = Array.isArray(row.input) ? row.input : [];
  const texts = [];
  for (const part of input) {
    if (part && part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
  }
  const text = texts.join('\n').replace(/\s+/g, ' ').trim();
  if (!text) return Array.isArray(row.input) && row.input.length ? '[非文本输入]' : null;
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

export function applyRow(state, row, agentName = 'main') {
  try {
    foldRow(state, row, agentName);
  } catch {
    // A malformed row must never take the dashboard down.
  }
}

function rateOf(cache) {
  if (!cache || !Number.isFinite(cache.inputTokens) || cache.inputTokens <= 0) return null;
  return cache.readTokens / cache.inputTokens;
}

function agentView(bucket, now) {
  const fresh = bucket.samples.filter((sample) => sample.t >= now - SAMPLE_WINDOW_MS);
  const tps = median(fresh.slice(-8).map((sample) => sample.v));
  return {
    name: bucket.name,
    model: bucket.model,
    thinking: bucket.thinking,
    tps: tps === null ? bucket.lastStep?.tps ?? null : tps,
    ttftMs: bucket.lastTtftMs,
    contextTokens: bucket.contextTokens,
    usage: { ...bucket.usage },
    input: inputTotal(bucket.usage),
    output: bucket.usage.output,
    cacheRate: rateOf(bucket.cache),
    lastStepAt: bucket.lastStep ? bucket.lastStep.time : null,
    active: bucket.lastRequestAt !== null
      && now - bucket.lastRequestAt < SAMPLE_WINDOW_MS
      && (bucket.lastStepEndAt === null || bucket.lastRequestAt > bucket.lastStepEndAt),
  };
}

export function buildSnapshot(state, ctx = {}) {
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const main = state.agents.get('main') || null;
  const agents = [...state.agents.values()]
    .map((bucket) => agentView(bucket, now))
    .sort((a, b) => (a.name === 'main' ? -1 : b.name === 'main' ? 1 : a.name.localeCompare(b.name)));

  const mainView = agents.find((agent) => agent.name === 'main') || null;
  const lastStep = main?.lastStep || null;
  const startedAt = state.turn.startedAt;
  const endedAt = state.turn.endedAt;
  const turnUsage = state.turn.usage;
  const turnInput = inputTotal(turnUsage);

  return {
    ok: true,
    generatedAt: now,
    server: ctx.server || null,
    session: ctx.session || null,
    headline: {
      input: turnInput,
      output: turnUsage.output,
      inputOther: turnUsage.inputOther,
      cacheRead: turnUsage.inputCacheRead,
      cacheCreation: turnUsage.inputCacheCreation,
      cacheRate: rateOf(state.totals.cache),
      turnCacheRate: rateOf(state.turn.cache),
      tps: mainView ? mainView.tps : null,
      ttftMs: mainView ? mainView.ttftMs : null,
      elapsedMs: startedAt === null ? null : (endedAt ?? now) - startedAt,
      contextTokens: mainView ? mainView.contextTokens : null,
      model: mainView ? mainView.model : null,
      thinking: mainView ? mainView.thinking : null,
      lastStepAt: lastStep ? lastStep.time : null,
    },
    turn: {
      index: state.turn.index,
      running: startedAt !== null && endedAt === null,
      startedAt,
      endedAt,
      prompt: state.turn.prompt,
      steps: state.turn.steps,
      toolCalls: state.turn.toolCalls,
      usage: { ...turnUsage },
      input: turnInput,
      output: turnUsage.output,
      cacheRate: rateOf(state.turn.cache),
    },
    totals: {
      input: sessionInput(state.totals.byModel, state.totals.cache),
      output: outputTotal(state.totals.byModel),
      cacheRead: state.totals.cache.readTokens,
      cacheInput: state.totals.cache.inputTokens,
      cacheRate: rateOf(state.totals.cache),
      steps: state.totals.steps,
      turns: state.totals.turns,
      toolCalls: state.totals.toolCalls,
      byModel: [...state.totals.byModel.values()]
        .map((bucket) => ({
          model: bucket.model,
          calls: bucket.calls,
          tokens: { ...bucket.tokens },
          input: inputTotal(bucket.tokens),
          output: bucket.tokens.output,
        }))
        .sort((a, b) => (b.input + b.output) - (a.input + a.output)),
    },
    agents,
    steps: state.steps.slice(-MAX_STEPS),
    tools: state.tools.slice(-MAX_TOOLS).reverse(),
    window: {
      firstRowTime: state.firstRowTime,
      lastRowTime: state.lastRowTime,
      truncated: state.truncated,
      partial: ctx.partial === true,
    },
  };
}

function sessionInput(byModel, cache) {
  let total = 0;
  for (const bucket of byModel.values()) total += inputTotal(bucket.tokens);
  return total || cache.inputTokens;
}

function outputTotal(byModel) {
  let total = 0;
  for (const bucket of byModel.values()) total += bucket.tokens.output;
  return total;
}
