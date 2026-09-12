# Kimi Status Web

Kimi Code 会话的本地实时状态面板：把终端状态栏搬进浏览器。

```
入 197.5k · 出 6.3k · 缓存 76% · ↑39 tok/s · ⚡1.7s · ⌈7d 已用12% 5d2h · 5h 已用60% 3h9m⌉
```

数据直接来自会话日志 `~/.kimi-code/sessions/.../agents/*/wire.jsonl`，只读本地文件，不联网、不改动会话内容；面板只监听 `127.0.0.1`。

## 面板里有什么

- **顶部状态行**：本回合输入 / 输出 token、会话缓存命中率、输出吞吐 (tok/s, 近期中位数)、首字延迟 (TTFT)
- **本回合**：耗时、步数、工具调用次数、输入拆分为未缓存 / 缓存读 / 缓存写
- **吞吐**：近期逐步采样折线 + 均值、平均输出
- **会话累计**：整会话输入 / 输出 / 缓存，以及按模型的调用统计
- **Agent**：主 / 子 agent 的模型、吞吐、首字、上下文、输出
- **工具调用**：最近调用流水（含进行 / 完成 / 失败）
- **逐步明细**：每次模型调用的输入、缓存读、输出、tok/s、首字、流式耗时
- **会话信息**：标题、工作目录、Git 分支、统计窗口

页面通过 SSE (`/api/stream`) 实时推送，默认 0.7 秒一拍；断线自动降级为轮询。

## 安装

```
/plugins install https://github.com/flymii/kimi-status-web
```

也可以直接从本地目录安装：`/plugins install <插件目录路径>`。

安装后执行 `/reload` 或 `/new` 生效。**默认不启动任何后台服务** —— 状态条自带数据源（走 kimi web 的 REST API）；想看更全的数据（子 agent、本回合耗时、按模型统计、完整面板页）时再手动起服务：`/kimi-status-web:open`，或把 `config.json` 里的 `autoStart` 设为 `true` 让它随会话自动拉起。

## 使用

```
/kimi-status-web:open       启动面板并给出地址
/kimi-status-web:status     打印一行实时指标
/kimi-status-web:userscript 把状态条挂到 kimi web 原页面（安装指引）
```

## 在 kimi web 的会话页面里显示（油猴脚本）

`kimi web` 的前端是打包在 CLI 二进制里的 SPA，插件没有往里注入 UI 的口子，所以状态条以**用户脚本**的形式挂在原页面上 —— 浏览器侧装一次，之后照常访问 kimi web 自己的地址，状态条就在消息输入框下面（作为输入框的兄弟节点插进 DOM，把它顶上去），并自动跟随你正在看的那个会话（从地址栏的 `/sessions/<id>` 取）。

1. 装一个用户脚本管理器（Tampermonkey / Violentmonkey）
2. 把 `userscript/kimi-status-web.user.js` 整段复制进「添加新脚本」，或用管理器的「实用工具 → 导入文件」直接选它
3. 刷新 kimi web 页面即可。脚本 `@match *://*/*`，但会在非 kimi web 页面上立即退出，所以局域网 / 反代域名都不用重新生成

点状态条展开：本回合（步数 / 工具 / 首字 / 缓存拆分）、吞吐折线、会话累计、额度、各 agent 明细，底部「完整面板 ↗」跳到独立面板页。整块 UI 跑在 shadow DOM 里并跟随 kimi web 的明暗主题，不会影响宿主页面的样式。

额度跟着当前会话用的供应商走（按模型别名路由）：kimi-code 模型显示 7d 周额度与 5h 滚动窗口的剩余比例和重置倒计时（数据来自 kimi web 服务的 `/api/v1/oauth/usage`，用本机 server.token 读取）；DeepSeek 模型显示账户余额（`api.deepseek.com/user/balance`，key 取自 config.toml）；其他供应商（如 ark）没有余额接口，额度区块自动隐藏。本机服务没开、回退到页面 REST API 时，只有 kimi-code 额度可查（页面 token 只管 kimi），DeepSeek 余额需要本机服务在跑。

**数据源两档，自动切换：**

1. **本机指标服务**（优先）—— 直接读 `~/.kimi-code/sessions` 下的日志，不需要 token，增量读、开销最小；也就是 `kimi-status-web serve` 那个 8710 服务（`status` 查看、`open` 启动）
2. **kimi web 自己的 REST API**（回退）—— 本机服务连不上时，改用**同源**接口：`/api/v1/sessions/<id>/snapshot` 取会话用量汇总，`/api/v1/fs:content`（带 `Range`）读 `session_index.jsonl` 和 `wire.jsonl` 尾部算 tok/s、首字延迟。token 取自页面自己存的 `kimi-web.server-credential`，所以**通过局域网 IP 或反向代理域名访问 kimi web 时同样可用**，只是面板里的步数/工具统计受尾部窗口限制（面板会标注「日志尾部」）

换本机服务端口后重新生成即可：

```bash
node scripts/build-userscript.mjs --port 8712
```

只想让脚本在特定站点跑（默认是全网 + 运行时判断）时加 `--match`，可重复：

```bash
node scripts/build-userscript.mjs --match "https://km.example.com/*" --match "http://127.0.0.1/*"
```

生成器把 `web/overlay.js` 和 `web/overlay.css` 一起内联进 `.user.js`，状态条只有一份源码。本机服务的 API 只对 `127.0.0.1` / `localhost` 来源开放跨域读写，其它网站拿不到你的会话数据。调试时在地址后加 `?ksw_poll=1`（改轮询）或 `?ksw_open=1`（默认展开）。

命令行直接用法：

```bash
node bin/kimi-status-web.mjs open            # 确保服务在跑并打开浏览器
node bin/kimi-status-web.mjs serve           # 前台运行（Ctrl-C 退出）
node bin/kimi-status-web.mjs status          # 服务状态
node bin/kimi-status-web.mjs stop            # 停止后台服务
node bin/kimi-status-web.mjs snapshot --line # 一行指标
node bin/kimi-status-web.mjs snapshot --json # 原始快照
node bin/kimi-status-web.mjs sessions        # 最近的会话
```

面板地址支持两个查询参数：`?session=<id>` 固定看某个会话，`?stream=0` 改用轮询（便于截图或在会掐断 SSE 的代理后面看）。

## 状态条不显示 / 变空时怎么查

按顺序看三件事：

1. **指标服务在不在跑**：终端执行 `node bin/kimi-status-web.mjs status`（或插件目录里的同名命令），
   不在跑就 `node bin/kimi-status-web.mjs open`。状态条连不上服务时会显示红色的「未连接 + 地址」，点开有提示。
2. **油猴脚本有没有生效**：kimi web 页面 → F12 → Console 里敲
   `document.getElementById('kimi-status-overlay')`，返回 null 说明脚本没注入（检查管理器里脚本是否启用、
   `@match` 是否是 `http://127.0.0.1/*`）。
3. **服务端口和脚本里写的是不是同一个**：脚本里的 base 默认 `http://127.0.0.1:8710/_kimi-status`，
   服务换过端口就用 `node scripts/build-userscript.mjs --port <端口>` 重新生成再装一次。

另外，`http://127.0.0.1:8712/` 那个地址已经不存在了（曾经的反向代理已移除），请直接用 kimi web 自己的地址。

## 配置

`~/.kimi-status-web/config.json`（可选，缺省即默认值）：

```json
{
  "port": 8710,
  "autoStart": false,
  "openBrowser": false,
  "tickMs": 700,
  "keepSessions": 6
}
```

`autoStart` 默认 **false**：服务不随会话自动启动，需要时手动起（`node bin/kimi-status-web.mjs open` 或 `/kimi-status-web:open`）。设为 `true` 则每次会话开始时自动在后台拉起。

服务不开着也能用 —— 状态条会自动改用 kimi web 自己的 REST API（见上一节），只是少几项明细（子 agent、本回合耗时、按模型统计、完整面板页）。

环境变量：`KIMI_CODE_HOME`（Kimi Code 数据目录）、`KIMI_STATUS_WEB_HOME`（本工具数据目录）、`KIMI_STATUS_WEB_PORT`（默认端口）。

## 说明

- 需要 Node.js 18+，零第三方依赖。
- 端口被占用时自动顺延（8710、8711…）；同时只会保留一个后台服务。
- 会话日志超过 16 MB 时，从日志尾部开始统计，面板会标注「日志尾部」。
- HTTP 接口：`/api/health`、`/api/sessions`、`/api/state?session=<id>`、`/api/stream?session=<id>`、`/api/follow?session=<id|auto>`。
