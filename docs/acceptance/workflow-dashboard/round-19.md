# Round 19：合并主线后的目录与导航恢复

2026-10-13，目录既有 32 项及新增 4 项真实存储/重挂载检查共 36/36 PASS，证据见 `round-19/browser-results.json`。源码 SHA256 与 round 18 一致：`80aa9905cdffafde417b800f87568748902c16932d62dd3dd592f50b5d7f13f4`。

夹具 HTML 从被 Playwright 拦截的 `http://127.0.0.1:18998/__fixture__` 加载，不启动运行服务；真实浏览器 `sessionStorage` 可读写。实际卸载 React 根内容再重挂载，确认 DOM 根已更换，工作流与配置 Tab 都恢复；非法保存页回到群消息；原生 Storage 方法模拟抛 SecurityError 后仍可进入工作流。新增检查不把 about:blank 的拒绝存储兜底误判为持久化成功。

原有目录、任务跳转/返回选择与焦点、加载/空/错误、过期请求、跨刷新去重、390px 和键盘检查继续通过。写入、浏览器错误、未知请求和原生弹窗均为 0。

```powershell
node docs/acceptance/workflow-dashboard/scripts/verify-workflow-browser.mjs C:/Users/64554/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright verify 19
```

本轮精确保留上游 sessionStorage setter、TaskOwnerSession、sessionBound 门禁、latestReading 和焦点恢复，同时保留本特性的目录/配置常驻挂载与返回工作流行为。截图在 `docs/tmp/workflow-dashboard/round-19/`；所有数据均为隔离夹具。
