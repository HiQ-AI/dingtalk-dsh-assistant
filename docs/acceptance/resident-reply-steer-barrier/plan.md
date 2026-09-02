# 验收计划

## 症状

主会话已经生成回复候选后，后续 Steer 可能在回复真正进入 Outbox 前到达；现有提交协议既不要求模型声明是否观察到它，也会在可靠回复之前返回工具成功。

## 根因

- pending 请求 claim 与业务回复提交是两个不同边界。
- 工具协议只有 `requestIds`，不能区分“已观察但不影响、留待下一步”的请求和“模型根本尚未看到”的请求。
- 新 Steer 插入与回复异步提交之间没有同群顺序门禁。
- Task 通知仍从 turn assistant 文本提取，无法把某个候选与观察过的 Steer 快照绑定。
- 若在 Task 串行尾链内等待 Resident 生成通知，新消息 Decision 又需要执行 Task 动作，会形成相互等待。
- 完成状态先落库、通知后生成时，旧补发筛选只覆盖存在 `lastCompletedResult` 的后续轮次，会漏掉首次完成通知失败。
- Outbox 已落库后的发送监听器异常仍向上传播，会造成工具已按持久化边界成功、入站处理却被反向标记失败的状态分叉。

## 修复

- 增加顶层 `observedRequestIds`，对含 effective reply 的批次执行当前普通 pending 全量一致性校验。
- observed 但未提交的请求保持 pending；同批独立处理继续使用多个 submission。
- 增加每群 reply barrier，在审阅校验后取得，在可靠 Outbox 后释放；新消息只在 Steer 前等待该门禁。
- 含回复的工具结果等待 committed，避免成功回执早于 Outbox。
- recheck 可与相关普通请求共同提交，并把 committed 委托到外层真实业务提交。
- Task 通知改为独立 `group_reply_submit`：普通 assistant 文本不构成提交，stale 后保留请求供下一 step 重生成。
- 等待信息通知与完成通知补发只在短 Task 事务内准备状态，退出 Task 尾链后再与 Resident 交互。
- 普通请求增加 `deliveryRecorded` 提交条件，避免工具 claim 先于 `steered` 状态失败而误执行动作或回复；recheck 合并路径共享相同条件。
- 历史导入使用独立尾链；配置和退订在等待 Resident 时不占群/Task 尾链，并等待 active submission committed 后执行最终复核。
- 订阅、配置和退订进入独立生命周期串行域；退订先持久化移除、再解绑与 dispose，失败时保留可用 Resident。
- 关闭先禁止入口并释放 admission 等待者，再等待已开始的可靠提交；配置生命周期在最终 teardown 前收口。
- Task 通知与历史导入增加独立的每群 Resident operation 跟踪和 transition barrier；切换前到达的操作先收口，切换后到达的操作等待并重新读取当前 Resident。
- 统一首次和后续完成通知的稳定结果键；补发扫描全部 completed result，并保留旧后续轮次缺少序号时的迁移规则。
- Outbox 监听器异常在持久提交后隔离并记录为恢复问题；普通 Decision 的持久写入失败明确拒绝、释放门禁且不自动重放已执行动作。
- 完成通知补发跳过没有群目标的退订历史 Task，并隔离单项 Resident 失败；后续有效群继续补发，最终以聚合错误显式报告失败项。
- 同步更新常驻会话提示词和 README 行为说明。

## 验证

按 `matrix.csv` 执行聚焦单测、全量测试、打包与静态检查。每一轮证据写入新的 `round-N.md`，全部通过后生成 `report.md`。
