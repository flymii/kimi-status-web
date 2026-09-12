# AGENTS.md

## 产品方向（用户偏好，2026-09-12 明确）

- **主战场是油猴脚本状态条**（`web/overlay.js` / `web/overlay.css`）：新功能默认只做在这里。
- **完整面板页（`web/index.html` + `web/app.js`）保持冻结**，不要再往上加新功能，除非用户特地提到。
- 面板页的既有功能照常维护（修复、跟随数据源调整），只是不新增。

## 代码约定

- 状态条只有一份源码：`web/overlay.js` + `web/overlay.css`，改完必须跑
  `node scripts/build-userscript.mjs` 重新生成 `userscript/kimi-status-web.user.js`。
- 零第三方依赖，Node.js 18+；Bash 走 Git Bash，路径用正斜杠。
