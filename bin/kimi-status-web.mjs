#!/usr/bin/env node
// CLI for the Kimi Status Web dashboard.

import process from 'node:process';

import { loadConfig } from '../src/config.mjs';
import {
  formatDuration,
  formatPercent,
  formatRate,
  formatTokens,
  statusLine,
} from '../src/format.mjs';
import { resolvePaths } from '../src/paths.mjs';
import { listSessions, findSession, pickActiveSession } from '../src/session-locator.mjs';
import { SessionTracker } from '../src/session-tracker.mjs';
import { createDashboardServer } from '../src/server.mjs';
import {
  ensureServer,
  findRunning,
  openBrowser,
  readRuntime,
  stopServer,
} from '../src/runtime.mjs';

const USAGE = `kimi-status-web — 本地 Web 实时状态面板

用法:
  kimi-status-web serve [--port N] [--open] [--json]   前台启动面板服务
  kimi-status-web open  [--port N] [--json]            确保服务在跑并打开浏览器
  kimi-status-web status [--json]                      查看服务状态
  kimi-status-web stop                                 停止后台服务
  kimi-status-web snapshot [sessionId] [--json|--line]  打印一次指标快照
  kimi-status-web sessions [--json]                    列出最近会话
  kimi-status-web --help

环境变量:
  KIMI_CODE_HOME          Kimi Code 数据目录（默认 ~/.kimi-code）
  KIMI_STATUS_WEB_HOME    本工具数据目录（默认 ~/.kimi-status-web）
  KIMI_STATUS_WEB_PORT    默认监听端口（默认 8710）
`;

function parseArgs(argv) {
  const options = { command: 'serve', flags: new Set(), values: {}, rest: [] };
  const [first, ...tail] = argv;
  if (first && !first.startsWith('-')) options.command = first;
  for (let i = 0; i < tail.length; i += 1) {
    const arg = tail[i];
    if (!arg.startsWith('-')) {
      if (tail[i - 1] === '--port') continue;
      options.rest.push(arg);
      continue;
    }
    if (arg === '--port') {
      options.values.port = Number(tail[i + 1]);
      continue;
    }
    options.flags.add(arg.replace(/^--?/, ''));
  }
  if (first && first.startsWith('-')) {
    if (first === '--help' || first === '-h') options.command = 'help';
  }
  return options;
}

function humanSnapshot(snapshot) {
  if (!snapshot || !snapshot.session) return '（没有找到会话）';
  const { session, headline, turn, totals } = snapshot;
  const lines = [];
  lines.push(statusLine(snapshot));
  lines.push('');
  lines.push(`会话    ${session.title || '(未命名)'}`);
  lines.push(`目录    ${session.cwd || '—'}${session.branch ? `  (${session.branch})` : ''}`);
  lines.push(`模型    ${headline.model || '—'}${headline.thinking ? ` · thinking ${headline.thinking}` : ''}`);
  lines.push(`回合    #${turn.index} ${turn.running ? '进行中' : '已结束'} · `
    + `${turn.steps} 步 · ${turn.toolCalls} 次工具调用 · 耗时 ${formatDuration(headline.elapsedMs)}`);
  lines.push(`上下文  ${formatTokens(headline.contextTokens)}`);
  lines.push('');
  lines.push(`本回合  入 ${formatTokens(turn.input)} · 出 ${formatTokens(turn.output)} · `
    + `缓存 ${formatPercent(turn.cacheRate)}`);
  lines.push(`本会话  入 ${formatTokens(totals.input)} · 出 ${formatTokens(totals.output)} · `
    + `缓存 ${formatPercent(totals.cacheRate)} · ${totals.steps} 步 · ${totals.turns} 回合`);
  if (snapshot.tools && snapshot.tools.length) {
    lines.push('');
    lines.push('最近工具调用');
    for (const tool of snapshot.tools.slice(0, 8)) {
      const mark = tool.ok === false ? 'x' : tool.ok === true ? 'v' : '.';
      lines.push(`  ${mark} ${tool.agent.padEnd(8)} ${tool.name}`);
    }
  }
  if (snapshot.window?.partial) {
    lines.push('');
    lines.push('注: 会话日志很大，指标从日志尾部开始统计。');
  }
  return lines.join('\n');
}

async function collectSnapshot(paths, sessionId) {
  const session = sessionId
    ? findSession(paths, sessionId)
    : pickActiveSession(paths);
  if (!session) return null;
  const tracker = new SessionTracker(session);
  let snapshot = tracker.poll().snapshot;
  // Large journals arrive in slices; keep draining until the reader settles.
  for (let i = 0; i < 50; i += 1) {
    const result = tracker.poll();
    if (!result.changed) break;
    snapshot = result.snapshot;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return snapshot;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const paths = resolvePaths();
  const config = loadConfig(paths.configPath);
  const wantedPort = options.values.port || config.port;
  const json = options.flags.has('json');

  switch (options.command) {
    case 'help': {
      process.stdout.write(USAGE);
      return;
    }
    case 'serve': {
      const running = await findRunning(paths, null);
      if (running && running.port === wantedPort) {
        process.stdout.write(`kimi-status-web 已在运行: http://127.0.0.1:${running.port}/\n`);
        return;
      }
      const server = createDashboardServer({
        paths,
        config: { ...config, port: wantedPort },
        log: (message) => process.stderr.write(`[kimi-status-web] ${message}\n`),
      });
      try {
        await server.start(wantedPort);
      } catch {
        await server.start(0);
      }
      const url = `http://127.0.0.1:${server.port}/`;
      process.stdout.write(`kimi-status-web 已启动: ${url}\n`);
      if (options.flags.has('open') || config.openBrowser) openBrowser(url);
      const shutdown = async () => {
        await server.stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return;
    }
    case 'open': {
      const result = await ensureServer(paths, { port: wantedPort, open: true });
      const url = `http://127.0.0.1:${result.port}/`;
      if (json) process.stdout.write(`${JSON.stringify({ ...result, url })}\n`);
      else process.stdout.write(`面板地址: ${url}\n`);
      return;
    }
    case 'status': {
      const running = await findRunning(paths, wantedPort);
      const payload = {
        running: Boolean(running),
        port: running ? running.port : null,
        url: running ? `http://127.0.0.1:${running.port}/` : null,
        health: running ? running.health : null,
        stale: readRuntime(paths) || null,
      };
      if (json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
      }
      if (running) {
        process.stdout.write(`面板运行中: http://127.0.0.1:${running.port}/  (pid ${running.health.pid}, `
          + `up ${formatDuration(running.health.uptimeMs)})\n`);
      } else {
        process.stdout.write('面板未运行。用 `kimi-status-web open` 启动。\n');
      }
      return;
    }
    case 'stop': {
      const stopped = stopServer(paths);
      process.stdout.write(stopped ? '已停止。\n' : '没有正在运行的服务。\n');
      return;
    }
    case 'sessions': {
      const sessions = listSessions(paths, { limit: 20, force: true });
      if (json) process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
      else if (!sessions.length) process.stdout.write('没有找到会话。\n');
      else {
        for (const session of sessions) {
          const age = formatDuration(Date.now() - session.activityAt);
          process.stdout.write(`${session.id}  ${age.padStart(7)} 前  `
            + `${(session.title || '(未命名)').slice(0, 40)}\n`);
        }
      }
      return;
    }
    case 'snapshot': {
      const snapshot = await collectSnapshot(paths, options.rest[0]);
      if (!snapshot) {
        process.stderr.write('没有找到会话。\n');
        process.exitCode = 1;
        return;
      }
      if (json) process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
      else if (options.flags.has('line')) process.stdout.write(`${statusLine(snapshot)}\n`);
      else process.stdout.write(`${humanSnapshot(snapshot)}\n`);
      return;
    }
    default: {
      process.stderr.write(`未知命令: ${options.command}\n\n${USAGE}`);
      process.exitCode = 2;
    }
  }
}

main().catch((error) => {
  process.stderr.write(`kimi-status-web: ${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
