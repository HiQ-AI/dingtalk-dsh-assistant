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

`group_decision_submit.decision` 公开为两个严格 `oneOf` 分支：`reply`（可带 actions/replyReview）或 `actions: [] + reason`；不得混填 reply/reason。联合类型错误展开为具体字段路径和 branch，最多返回八项，便于修正；非法提交不产生 Task 或 Outbox。

已路由 Topic 可在同群还有待路由消息时准备决策。提交仍在 Store 群锁内核对所有已入站的未知输入、Topic/Task 版本和来源归属。`routing-required` 返回 `nextAction: wait-for-routing`、`retryScheduled: true`，表示 Host 在内存保留未接纳草稿；路由完成后重新走完整提交校验。无关输入不要求重新调用模型，同 Topic 新版本使旧草稿失效。草稿不持久化，进程重启后按当前来源重建，不视为已接纳业务意图。

## 报告、许可与停止

报告回执 received 只表示已经收件；reviewStatus 与 applicationStatus 表达审阅及应用阶段。submissionId 相同但正文摘要不同会冲突。旧版本报告保留历史，不能换新版本号重提旧证据。

Task running 不是执行许可。报告等待、暂停和取消须停止后续叶子步骤；恢复通过同一许可入口，达到并发限制则排队。协调请求仍按群串行；有其他有效请求排队时，每次最多执行一个原生 step，工具及 post-execute 结果落稳后再让出，原 Session 排队续行。路由连续获槽两次后给非路由请求机会；公平让出不消耗协议重试次数。没有竞争时继续当前轮次，未知未归类输入的提交安全门禁不取消。

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

## workflow-v2 上下文只读接口

以下接口复用 Resident 的本地只读访问边界，不注册为模型写工具；对象必须属于当前配置的 workflow 群。不存在或跨群返回 404，非法参数与版本失效返回 400，错误码写入 `error`。

| GET 路径 | 参数与结果 |
| --- | --- |
| `/state/workflows/:runId/trace` | `cursor` 为记录偏移，`limit` 默认50、最大100；返回 `status/reason/revision/items/nextCursor/total`。包含由其他 MessageRun 承载、但涵盖当前消息的共享 IB；每项保存 `carrierRunId/sourceRunIds/input/output/usage`。 |
| `/state/workflows/topics/:topicId/context` | 事实 `cursor` 与批次 `intentCursor` 独立；`revision` 为首屏返回的上下文版本，续页据此拒绝混入新版本。返回当前事实、`intentRuns`、`nextCursor/intentNextCursor`。批次固定每页50条，末尾可能需要读取空页确认结束。 |
| `/state/workflows/:runId/evidence/:ref` | `ref` URL编码。仅允许当前消息已绑定的快照来源或持久材料，不读取任意路径/URL。`cursor` 为UTF-16原文坐标，`limit`默认2000、范围2–8000；续页必须携带首屏 `hash`。返回 `text/start/end/totalLength/totalBytes/hash/nextCursor`，不切断代理项字符。 |
| `/state/tasks/:taskId/runs` | `cursor` 为上一页返回的Run序号，`limit`默认20、最大100；返回 Owner 与历史 Run/节点。Owner `sessionBound=false` 时，`sessionId`仅为预留身份。`total=null`表示未执行全量计数。 |

`sourceManifest` 记录 IB 使用的来源版本及范围，`taskFactVersions` 记录事务接纳用的语义版本。材料节点的 `coverage.mode=model_extraction` 表示模型已处理各页并返回通过原文匹配的引文；不代表所有语义事实都被正确提取。历史没有记录的字段保持缺失，不回填虚构的读取证明。

IB 可返回 `factRevisions: [{ factId, sourceQuote, scope }]`。Host 只接受原发送人当前原文明示的整条撤销或替换，scope只接受“当前话题”或“整条条件”；存在局部范围、其余条件保持等证据时保留原条件并请求澄清，不把局部变更扩大到其他事项。数据库再次校验话题、原提出人、引文与当前版本。旧事实保存为 `superseded`，保留替代来源；不会按时间新旧自动删除条件。

消息 trace 只读响应补充 message.text/receivedAt；记录含 startedAt、completedAt、attempt，意图记录含 topicTitle 与 sourceMessages（同群原文、发送者名称、时间及 current 标记）。耗时采用本次领取开始至完成，不以记录创建时间代替；历史缺失字段视为未知。

消息 trace 的步骤展示现在使用 summary={title,conclusion,rows:[{label,value}]}；响应不再包含 input、output、usage、evidenceRefs、deterministic。业务摘要在服务端从原持久记录投影，前端不展开或 stringify 全量模型上下文。原文证据读取仍由内部原始记录进行范围校验，不依赖精简后的展示响应。
