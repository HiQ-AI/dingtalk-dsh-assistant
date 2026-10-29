# Round 3 — 跨入口唤醒与 replan 持有

日期：2026-10-29（Asia/Shanghai）

## 跨入口 owner-wake hold

- 来源：platform 报告 `--owner-wake` 实验 exit 0；Lead 独立读实验脚本 `scripts/owner-admission-race.mjs:182-230`。工作树未提交代码，真实 SQLite/service，Owner 使用受控桩；不访问现场库、不重放真实消息。
- 入口：`node docs/acceptance/inbox-latency-408-409/scripts/owner-admission-race.mjs --owner-wake`。
- 门闩顺序：先让 `kickTask` 的 wake.list 响应进入 gate；发起 replan 并拦住 task.revise 提交；释放 wake 后等待旧 tracking 到 finally 清理；此时断言 claims=0；再释放 revise 并等 service.whenIdle。
- 结果：最终 `claims=1`、`ownerRuns=1`、`revision=2`，命令 exit 0。证明此受控跨入口交错下，replan 提交前没有 task claim；旧 tracking 清理后提交新版本只产生一个 claim/Owner。
- Owner-wake 分支验证的是跨入口退让，不含 300ms 采样。独立 `--held-open-slot` 分支在 hold 已建立、revise 尚未提交期间，先让第一条执行 drained 释放唯一并发槽，第二条仍 queued；300ms 样本中 execution.list 增量 5、claims 保持 1，exit 0。该有限采样不是全局无空转证明，详见 `round-1-owner-admission.md:35`。
- 实验使用 service 代码路径 `task-session-service.js:975` 与 `:250` 的 wake.list 栈位置拦截；源码行变化时需同步实验拦截点。本记录不证明真实 Agent 的取消/执行，也不代表生产、现场 #408/#409 性能验收。

## 旧顺序指纹 writer 反例

- 测试方报告：指定 profile 后运行 `node --test --test-name-pattern='Web material failure recovers once' test/task-topic-routing-native.test.js`，1 PASS、0 FAIL/skip，7,824.7396 ms。
- 首次写入时反转 action/topicRef 的 key 顺序并调用真实 Store，断言真实持久化的未完成记录 fingerprint 与 source canonical 顺序不同；重启后重试保留原 fingerprint，同值请求成功、异值拒绝，revision/Owner 不增加。
- 这是当前测试构造下针对 writer 顺序的反例，覆盖真实 Store 持久写入路径；不代表旧版本数据库兼容，也未模拟突然崩溃或真实外部副作用。

## 仍未覆盖

- 不模拟崩溃、历史版本数据库兼容、真实外部副作用或现场消息重放。
- Owner cancel-failure 的早期失败仍按 round-2 保留；后续诊断已确认未来 nextRetryAt 保持 busy 是既有 backoff 合同，fixture 设到期后 recover 可继续，最终专项 1 PASS、4,450.4804 ms。旧 Owner 在该例本已排空，不证明活旧会话取消失败后的排空。
- 此实验不能替代真实慢旧 Owner 双 gate、Host 子阶段时序投影或稳定 diff 的完整相关回归。
