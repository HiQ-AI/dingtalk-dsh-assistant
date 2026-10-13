# Round 1：内置流程缺失

日期：2026-10-13。执行 `verify 1`，浏览器结果为 FAIL。

通过：新增导航位于任务看板之后、进入工作流页才请求目录、首屏加载态、键盘 Enter 打开导航、初始请求失败展示。

失败：夹具返回 `workflows` 5 项与 `builtInWorkflows` 1 项，列表仅有 5 项；内置「查询任务进展」没有展示。最小断言为列表按钮总数 `5 !== 6`。后续用例尚未执行。

- 原始结果：`round-1/browser-results.json`。
- 实现 SHA256：`6b51116f5c36b1a990caa5c9a8a259d5356b9cc317a8062e05bee0f2187430c5`。
- `pageErrors=[]`、`writes=[]`、`unexpectedRequests=[]`。
- 本地失败截图：`docs/tmp/workflow-dashboard/round-1/verify-failure.png`，不入库。

此轮是完整 Observer 源码的浏览器夹具验证，不是部署或钉钉业务验证。
