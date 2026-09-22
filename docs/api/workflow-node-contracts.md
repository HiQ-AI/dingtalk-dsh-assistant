# 工作流节点契约

本页描述当前源码接口。持久化 domain v9，新增 Task 的 contractVersion 为 2；历史终态可以没有 contractVersion，outcome 为 legacy-unknown 时不得投影为成功。

## 所有权与节点产出

| 边界 | 权威输入 | 输出与核验 |
| --- | --- | --- |
| 归类与决策 | Host 绑定请求、群、来源 Unit、版本 | 模型提交语义判断；Host 重查来源归属、输入与任务版本 |
| 计划 | 当前来源、workflowRefs、已退休 ID | task_plan_prepare 生成稳定 ID；plan-confirmed 带 plan；来源覆盖与前序依赖由 Host 检查 |
| 阶段 | 已确认 plan 和当前 stageId | stageOutput 引用 artifactRefs/evidenceRefs；Host 校验顺序、版本、引用和证据归属 |
| 完成 | 当前 planRevision 和逐项 criterionReviews | 必需验收项通过，独立检查要求不得以模型自述替代；业务结果与 notificationIntent 同次保存 |
| 通知 | 已提交结果及原意图身份 | 生成草稿、入 Outbox、发送回读分别恢复；送达不能从模型结论推断 |

工具声明由同一 Zod schema 投影为 DSH 支持的 JSON Schema；Host 保留完整 Zod 与关联校验。审阅工具按绑定请求 kind 公开 schema，提交仍由 Host 保存的 kind 解析。调用者不能更换 kind、群或版本绕过门禁。

## 报告、许可与停止

报告回执 received 只表示已经收件；reviewStatus 与 applicationStatus 表达审阅及应用阶段。submissionId 相同但正文摘要不同会冲突。旧版本报告保留历史，不能换新版本号重提旧证据。

Task running 不是执行许可。报告等待、暂停和取消须停止后续叶子步骤；恢复通过同一许可入口，达到并发限制则排队。协调请求仍按群串行，归类有优先权但通过有限连续派发改善其他审阅等待；未知未归类输入安全门禁不取消。

stopRequest 表达 requested / reconciling / settled。已登记动作结果未知时保持对账，不把取消请求当作外部回滚完成。只有取消可越过同 Task 全部处于 blocked 的 Decision 保留；普通追加或重开仍受冲突检查。旧 blocked 记录和已应用操作不得删除。原操作恢复会再次检查当前 Task 版本和停止状态。

## Host 原操作恢复 API

`POST /config/groups/:groupId/topics/:topicId/decisions/:decisionId/operations/:operationId/retry`

```json
{ "resolution": "not-applied", "reason": "独立查询确认该操作未应用，说明具体查询证据" }
```

- resolution 只允许 not-applied / applied；reason 必须非空。
- 路径决定身份；body 不允许额外字段覆盖群、Topic 或操作身份。
- 只允许 blocked 决策恢复；applied 必须能从 Task.appliedOperations 账本证明，不能靠文字自报。
- 恢复身份必须与持久 failureOperationId 一致；不能用另一个已应用动作或既有 Outbox 的回执解锁失败动作。
- Outbox 提交故障使用该 Decision 的 outboundId 作为 operationId；applied 要求原 Outbox 已存在。
- not-applied 与持久账矛盾、Task 版本变化或 stopRequest 未解除时拒绝。恢复使用原身份，已经应用的操作永不重放。
- 返回 202 表示本次恢复请求已处理，具体是否 completed/blocked 读取响应状态；结构错误 400，状态或证据冲突 409。
- Runtime 对应 `retryDecisionOperation(args)`。这是 Host 管理接口，不注册为模型工具；沿用 Resident 本地管理接口访问边界，没有新增远程身份认证。

自动恢复仅对已知本地幂等操作且明确标记 code=storage_transient 的错误开放，初次加重试总共三次。attempt、nextRetryAt 保存于 Decision；显式对账恢复保存 recoveryReason/retryBaseAttempt，累计 attempt 不归零。未分类错误直接 blocked。持久化错误导致无法记失败时，本进程停止继续派发该决定并报告错误；重启仍按已保存尝试数与幂等账核对。

通知独立恢复：`POST /tasks/:taskId/notifications/:intentId/retry`。它恢复原通知意图，不重新完成 Task。

## 确定性脚本边界

coordination-context 的材料 manifest 保存身份、正文摘要、分页读取覆盖、缺失原因和完整性；不能把缺失正文标记为已读。实现不做无限递归抓取，也不根据材料内容扩大授权。

task-checks 的 artifact-sha256 检查固定 checkerId/version，校验登记文件与预期摘要并保存 Host 检查回执。文件无法读取或结果未知不等于 pass。模型证据与 Host checker 证据使用不同 schema，模型不能自填 checker 身份。

task-actions 仅接受 Host 固定注册的适配器，每个适配器实现参数解析、资源标识规范化、execute 和 reconcile；执行前检查版本、取消和授权。prepared/executing/unknown 占用相同资源键，unknown 先 reconcile。未接入适配器的 shell/SQL/部署不受此账本覆盖，不承诺外部 exactly-once。

## 数据切换

见[迁移 runbook](../ops/workflow-storage-migration.md)。v8 活动 Task 保存原快照、递增输入版本、分配新叶子会话并设置 migrationReview:required。显式 resumeTask 清除该门禁、保存 workflow-migration-resumed 事件、清除当前旧检查点，要求新结构化计划；启动不得自行恢复旧会话。历史事实留在迁移快照和审计事件中。
