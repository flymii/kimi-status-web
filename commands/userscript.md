---
description: 在不换地址的前提下把状态条挂到 kimi web 原页面上（油猴脚本安装指引）
---

kimi web 的前端打包在 CLI 二进制里，插件没有注入 UI 的入口，所以「原地址 + 状态条」只能靠浏览器侧的用户脚本。
做两件事：

1. 确认本机指标服务在跑（脚本要从它跨源取数据）：

```bash
node bin/kimi-status-web.mjs status
```

没跑就 `node bin/kimi-status-web.mjs open`（它会后台常驻，端口默认 8710）。

2. 让用户装脚本（一次性）：

- 需要 Tampermonkey / Violentmonkey 这类用户脚本管理器
- 脚本文件在插件目录下的 `userscript/kimi-status-web.user.js`
- 两种装法：整段复制内容 → 管理器里「添加新脚本」粘贴保存；或用管理器的「实用工具 → 导入文件」直接选这个文件
- 装完刷新 kimi web 页面，右下角就会出现状态条（`@match http://127.0.0.1/*`，端口变了也不用改）

换过指标服务端口的话，重新生成脚本再装：

```bash
node scripts/build-userscript.mjs --port <端口>
```

如果用户不想装浏览器扩展，改推荐代理方案：`/kimi-status-web:attach`（不用装任何东西，代价是访问地址变成 8712）。

$ARGUMENTS
