# 第 1 轮：修复前复现

2026-10-13，基线提交 `44646d2056375b32ebf2ed2f7812d946473f9722`，Observer SHA256 为 `9670ed295b99b00700bb2e12062434c0ddf860fe9795f35d124f4cab56691ac8`。

独立 headless Edge 155.0.4283.45 加载真实 React、ReactDOM 和完整 Observer。宿主插槽及 GET 接口为隔离夹具。选择任务看板后跨真实五秒轮询、手动刷新仍在任务页，排除轮询回调直接切页；随后用 ReactDOM.flushSync 真卸载并重新挂载，确认 DOM 根节点被替换，当前页面回到群消息。因此页面保持用例为 FAIL；基线脚本断言“复现旧错误”本身通过。

运行：`node docs/acceptance/observer-refresh-navigation/scripts/verify-browser.mjs --source docs/tmp/observer-refresh-navigation/old-web-client.js --baseline`。3 条断言通过，页面异常和业务写请求均为 0。结果见 [browser-results.json](round-1/browser-results.json)。旧源码可从上述提交提取；截图及旧源码留在 docs/tmp，不入库。

现场 Web/Runtime 端口未监听，没有证据证明用户实例实际由哪种自动刷新触发重建。宿主代码表明 conversation 为 session-maybe，会话切换或消失能使组件重建；普通同会话重渲染使用稳定组件。
