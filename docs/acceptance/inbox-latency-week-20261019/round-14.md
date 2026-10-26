# Round 14：投影修后与浏览器验收断言修正

2026-10-26；仅源码及隔离 fixture。历史失败不覆盖，本轮不是最终交付结论。

## 实际结果

- 定向代码测试 221/221 PASS，fail/cancelled/skipped 均为 0；独立证据 `round-14/targeted.log` 末尾。
- 真 Edge 浏览器首次扩展验收 FAIL。前五项通过，但失败行文本断言仍要求“历时未记录”；实际产品显示“未完成，需排查后按原请求恢复”和破折号，不展示数字完成历时。具体文本、stack、客户端 SHA 保留在 `round-14/ui/browser-result.json`。
- 该失败不是产品已完成；它暴露了验收脚本仍沿用旧预期。按当前失败无完成戳合同修正脚本，后续另外记录修后结果，未改旧 JSON。
- 此次 `errors=[]`、`writes=[]` 仅证明浏览器没有捕获到 JS 错误或越界写请求，不等于整个验收通过。

## 修后覆盖入口

复用 `scripts/verify-inbox-browser.mjs`，真实 React/ReactDOM + 真实 HTTP handleRequest + 合成 runtime + 真 Edge；浏览器对外请求有拦截，仅允许 fixture loopback 的白名单合成恢复 POST。既不连业务 API 写入，也不使用 installed-profile 去改真实运行态。

最终脚本核失败主行/筛选/详情/刷新、startup 自动补偿、后来成功、收发鉴权阻塞再恢复、同步单飞、unknown 只核验、delivered 无重发入口。最终结果见 `round-16/ui/browser-result.json`，不得用本轮 221 项或前五个 UI 检查替代最终证据。
