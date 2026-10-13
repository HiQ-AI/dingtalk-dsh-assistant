# Round 7：目录范围浏览器通过

日期：2026-10-13。`verify 7` 的 32 项检查全部通过，原始结果 `round-7/browser-results.json` 已独立回读。

- 真实 React 18、Edge 155.0.4283.45 headless，完整 Observer 源码 SHA256：`ba4608c327e15468c40ede53692d0acc6abeacc1394eceec8f1b8b109735e6e1`。
- 目录四类流程、节点与职责、维护链接、本次/归档任务关联、原任务详情返回及焦点、空态/禁用/错误重试、刷新内容保持、取消过期返回均通过。
- 目录慢请求跨两次已完成的全局自动刷新，仅保持一份目录请求，返回后仍可正常读取。
- 1440px 左右与 390px 上下布局通过，无页面横向溢出；两张截图人工查看，列表、状态、详情及维护入口可读。
- `pageErrors=[]`、`writes=[]`、`unexpectedRequests=[]`。

复现：

```powershell
node docs/acceptance/workflow-dashboard/scripts/verify-workflow-browser.mjs C:/Users/64554/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright verify 7
```

截图仅保留本地 `docs/tmp/workflow-dashboard/round-7/workflow-desktop.png` 与 `workflow-narrow.png`。这是新增配置范围接入前的目录浏览器证据；配置用例尚未执行，最终源码仍需回归。本轮不代表整体特性全绿，不写最终 report；未部署、未访问正式运行时或钉钉。
