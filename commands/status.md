---
description: 用一行文本打印当前会话的实时指标（入/出 token、缓存、tok/s、首字延迟）
---

读取最近活跃会话的实时指标并汇报给用户。

在插件根目录下执行：

```bash
node bin/kimi-status-web.mjs snapshot --line
```

输出形如 `入 197.5k · 出 6.3k · 缓存 76% · ↑39 tok/s · ⚡1.7s`，可以直接贴给用户。

需要更完整的信息（回合、上下文、会话累计、最近工具调用）时去掉 `--line`；需要原始 JSON 时加 `--json`。

$ARGUMENTS
