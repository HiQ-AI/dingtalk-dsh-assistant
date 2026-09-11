# Round 1：最新 main 复核

基线：`origin/main@f14a919`，包含已合并 PR #92、#93、#94。

- `pnpm install --prefer-offline`：成功。
- `pnpm test`：416/416 PASS。
- 当前运行现场 `/health`：DWS 入站正常，但仍为 `degraded`，`recoveryIssueCount=116`；因此不能把 PR 已合并等同于现场已恢复。
- 今日相关 Task 均已进入 `completed`；其中 UAT3 上游名称纠正任务记录 PR #349、Woodpecker #289 和真实对象页面复验，生产发布任务记录 Tag/Woodpecker/Registry/Pod/入口证据并明确未执行生产业务 E2E。
- 当前任务流程配置只在 UAT/生产/重构建等选定流程中包含 Woodpecker/源码包要求，普通排查、方案、评审和数据导出流程没有该要求；未把开发部署规则塞进所有叶子。

仍失败：F11、F13、F14、F17。其余项目已有当前代码反例、现场完成记录或流程配置证据。业务语义类 PASS 是本轮有界样例结论，不表示自然语言判断永不出错。

