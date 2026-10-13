# Round 12：补齐配置首屏加载观察

日期：2026-10-13。round 10 已覆盖错误/空态/重试，但没有固定住慢响应观察首屏加载；本轮在 API 夹具持有首次配置读取，确认「正在读取配置…」后才返回未提供服务错误，再继续原配置全流程。

`configuration 12` 的 15 项配置检查全部通过，与 round 10/11 使用相同源码 SHA256 `390b95c85f093e2de3a9a1c8dc05cbb57353bdab6a729d03cdd7fbc468eb41b2`。原始结果见 `round-12/browser-results.json`；9 次写请求只在白名单隔离夹具内发生，无额外网络或写请求、无原生弹窗、无浏览器错误。

复现：

```powershell
node docs/acceptance/workflow-dashboard/scripts/verify-workflow-browser.mjs C:/Users/64554/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright configuration 12
```

本轮补足既定加载态用例，不扩展产品范围。目录与配置完整浏览器证据以 round 11/12 为准，持久化、执行冻结与真实消费路径仍由专项测试另行证明。
