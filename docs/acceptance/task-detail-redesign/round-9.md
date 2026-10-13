# 第九轮：最终组合验收

2026-10-13，`node docs/acceptance/task-detail-redesign/scripts/verify-browser.mjs round-9`：24/24通过、零页面错误、零业务写入。独立读取结果JSON和当前产品摘要一致；最终矩阵31项全绿，历史失败均保留。

## 本轮修正与证据

第八轮之后仅修浏览器合成B任务的计划和对应摘要：单个完成步骤、单个已完成阶段、B自己的已完成Owner、2分钟单步累计时长。共享完成夹具断言检查任务状态、等待原因、plan与executionNodes的阶段集合及进度阶段一致，覆盖Owner-only与B两种场景。产品源码未修改。

再次独立查看 cross-task-clean-notice.png：B仅显示“01 · 调查与准备 · 已完成”，没有A的阶段状态或删除提示；直接打开B后再刷新仍选中B的步骤。Owner-only的完成空态也通过。1440px桌面、390px窄屏、明暗色、键盘、懒读取、长文本、删除回退、慢响应隔离以及本轮新增关联场景均包含在24项自动断言中。

结果及截图：`docs/tmp/task-detail-redesign/round-9/`。浏览器 Edge155.0.4283.45、React18.3.1；产品SHA256 `b6e0898858786273dd69502ccbcc3cf2aca571f591490149669cfded8480c85b`，主合成夹具SHA256 `254da5c1c175d58af56275fb9f388460204401409a9dcb11827006285405dde8`（后续子场景由脚本构造）。浏览器脚本 `node --check`退出0。

## 最终工程证据沿用说明

矩阵round-9是最终状态汇总：浏览器本轮重跑；Observer38/38来自第七轮；Service10/10及真实v25 checkpoint1/1来自第六轮；双包、严格审计、产品语法和设计lint来自第八轮。相应产品源码未改变，不将沿用证据冒充全部重跑。最后仅设计文档追加跨任务提示说明，文档lint及diff空白检查再次退出0。

双包摘要保留在 `package-check-round-8.json`，包内源码与当前摘要一致；无需因测试夹具调整重复打包。后端SHA256 `da0d27ac64cf0dc0cf5b1126def6f5bae33eba20e0cc610e4e853ffa4a842c2b`。独立代码复审未发现剩余阻断项。

## 验证边界

浏览器运行完整Observer源码与真实React，DSH外壳/primitive、会话导航和API为隔离替身；无真实任务写入。v25测试使用临时本地双仓、真实检查/本地验收流程、受控HTTP及模拟PR回执。测试、包内字节、部署及钉钉业务链路分别计证；正式实例未部署，真实宿主导航和业务E2E不在本轮证明范围。
