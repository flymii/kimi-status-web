---
description: 打开 Kimi Status Web 实时状态面板（入/出 token、缓存命中率、tok/s、首字延迟）
---

启动（必要时）并打开本地实时状态面板，然后把地址告诉用户。

在插件根目录下执行：

```bash
node bin/kimi-status-web.mjs open --json
```

如果当前目录不是插件根目录（找不到 `bin/kimi-status-web.mjs`），改用安装后的固定路径：

```bash
node "$HOME/.kimi-code/plugins/managed/kimi-status-web/bin/kimi-status-web.mjs" open --json
```

命令会返回 `{"port":...,"url":"http://127.0.0.1:...","started":true|false}`，服务在后台常驻（默认端口 8710，被占用时自动 +1）。把 `url` 给用户，并说明面板会跟随最近活跃的会话自动刷新。

如果用户想固定看某个会话，把会话 ID 拼到地址上：`http://127.0.0.1:<port>/?session=<sessionId>`；会话 ID 可以用 `node bin/kimi-status-web.mjs sessions` 列出。

$ARGUMENTS
