# DWS 入站桥存活恢复

## 症状与边界

本地 DSH Web 在 2026-09-02 的 HTTP Runtime 仍可响应 `/health`，但订阅群的持久消息停在前一天；同一 DWS profile 的只读范围拉取能返回后续群消息。这说明故障发生在 DWS listener / bridge 回补到 Runtime 的链路，尚未进入群消息 Decision 或 Task 路由。

本次只修复常驻入站桥的存活、恢复与可观测性；不改变 Decision 的语义分组、Task 准入或历史消息的业务判断。

## 根因

1. listener 的 `done` 后仅对运行中或等待中的 Task 记录告警，不删除 subscription、也不重连；无活动 Task 时会静默失联。
2. 初始补拉调用未分页的 `readGroup()` 却要求 `complete === true`。实际 DWS 默认读取可以返回 `complete: false, hasMore: true`，因此启动补拉被丢弃；范围读取虽会自动翻页，但人为限制为 500 条时，积压超过该上限也会持续返回不完整结果。
3. `/health` 只反映启动恢复错误和 DWS 配置态，不能反映 listener 是否 ready、是否已退出或最近补拉失败。

## 修复设计

- 每个订阅群维护内存态 bridge 状态：listener 状态、连续失败次数、最后 ready/退出/事件/补拉时间，以及最后 listener 与补拉错误。
- listener 退出、启动异常或 ready 超时后，以受限指数退避重建；旧 listener 的异步完成不得覆盖新 listener 状态，停止 bridge 后不得再重连。
- 只在 listener 已 ready 后执行初始回补，避免范围读取结束和订阅真正生效之间出现消息空窗。初始和周期补拉统一使用 `readGroupRange()` 的完整范围读取。范围读取保留 DWS 原生自动翻页且不人为截断消息总数；补拉串行化，但单群失败不能阻断其他群。本轮成功会清除该群的补拉错误。
- Runtime HTTP 健康接口接入 bridge 快照。DWS 模式只有所有订阅群 listener 已 ready 且最近补拉无错误时才报告 `status: ok` 和 `inboundProcessing: true`；同时返回可诊断的 DWS 群状态。

## 验收

1. listener 非正常退出后自动重连，即使该群没有 running/waiting Task。
2. ready 超时不会永久卡住，且 stop 后不会继续重连。
3. 启动补拉使用完整范围读取；DWS 返回后续消息时会进入 `runtime.ingest()`。
4. 自动翻页的范围读取不设 500 条人为上限，积压消息不会反复因 `hasMore` 被丢弃。
5. 单群补拉失败会降级健康状态、记录原因、继续处理其他群，后续成功会恢复健康。
6. `/health` 与只读 transport 状态能区分“配置为 DWS”与“实际可入站”。
