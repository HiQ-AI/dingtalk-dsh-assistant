# Round 11：同源码目录回归通过

日期：2026-10-13。配置 UI 接入后，`verify 11` 的 32 项目录检查全部通过，原始结果见 `round-11/browser-results.json`。

源码 SHA256 与 round 10 及独立 `Get-FileHash` 回读一致：`390b95c85f093e2de3a9a1c8dc05cbb57353bdab6a729d03cdd7fbc468eb41b2`。新增「配置」导航与流程变量只读读取没有破坏目录、任务关联/返回、窄屏、错误恢复、慢请求去重与过期请求取消。

本轮还覆盖受信 `task-engineering-` 派生任务关联，以及旧引擎同 workflowId 不混入新流程任务。目录模式 `writes=[]`，浏览器错误、额外写入、原生弹窗及未知网络请求均为空。

复现：

```powershell
node docs/acceptance/workflow-dashboard/scripts/verify-workflow-browser.mjs C:/Users/64554/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright verify 11
```

截图位于本地 `docs/tmp/workflow-dashboard/round-11/`，不入库。此轮仍是独立浏览器源码夹具验证，未部署。
