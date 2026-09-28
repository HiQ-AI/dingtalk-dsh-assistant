# 工作流节点契约

新增流程的建设步骤与 `workflow-v2` Node 定义见[框架建设手册](../../packages/dingtalk-dsh-assistant/README.md)。本页前半部分的 domain v9、Task contractVersion 2 和报告工具属于 Resident Task 合同；后面的原生工作流只读、Web 确认及维护接口另有对应范围。原生节点使用 `execution_node_submit`，不要混用旧叶子任务的计划/报告工具。

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


### 任务节点产出与文档

`GET /state/tasks/:taskId/runs/:runId/nodes/:nodeRunId/output?ref=:outputRef&detailRevision=:detailRevision` 返回 `text/overview/nextCursor/totalLength`，有文档时附 `documentName`；cursor 默认 0，limit 默认 1200、上限 8000。对应 `/document?ref=:outputRef&detailRevision=:detailRevision` 按需下载 UTF-8 Markdown，响应为 attachment、Cache-Control=no-store。详情客户端的所有分页和下载均传入同一 `detailRevision`；引用或版本变化返回 409 `TASK_OUTPUT_CHANGED`。两条路径核对当前配置群、最新物理 Task、当前计划阶段、Run 当前有效节点及准确输出引用；旧执行、移除阶段、旧代节点、失效结果、文档不存在或跨范围返回 404。省略详情版本的内部只读调用仍须通过全部当前归属校验；不允许借此读历史。工件读取前后再次核对版本。文档正文不放进列表。

新工程方案是节点实际保存的 Markdown 文档工件；历史补丁导出的修改记录明确标注未保存方案说明。旧工作目录仅从同一 nodeRunId、同一 generation 的成功 workspace 效果回执读取，不挪用其他轮次的目录。

方案编写及方案检查节点只显示实际方案工件路径，不展示正文、文件数量、展开或下载入口。当前文档与补丁持久化在 JSON 工件中，因此显示真实 JSON 路径，不虚构独立 Markdown 文件路径；其余节点保持原展示。
# Web 当前阶段确认接口

`POST /tasks/{taskId}/confirm-stage` 仅允许受信本机 Web 来源及已配置 `webActorId`；请求不能自行声明 actor。当前仅支持正式 Web 来源任务。

先从 `GET /state/tasks` 的目标任务读取 `stageConfirmation`。仅当前 active 的 Web 任务处于合法 `waiting_confirmation` 且全部前序成功时返回绑定对象（下方除 requestId、confirmationText 的全部字段），其他情况为 null。runSequence 使用该任务全部运行计数，不受任务列表分页影响。调用者原样提交绑定并补充唯一 requestId、用户确认正文；无需读取控制库。读取后状态变化仍由 POST 的事务版本校验拒绝。

```json
{
  "requestId": "confirm-uat-merge-1",
  "requirementRevision": 1,
  "controlRevision": 1,
  "planRevision": 1,
  "runSequence": 1,
  "stageId": "stage-2",
  "outputRef": "sha256-实际前序产物摘要.json",
  "confirmationText": "用户针对当前阶段的明确确认正文"
}
```

所有版本和产物必须来自当前任务状态，示例不能直接执行。接纳时核对当前唯一等待确认阶段及其已成功前序产物；应用时原生确认事务再次核对要求、控制、计划和产物。202 表示耐久接纳成功；相同 requestId 和完整请求重放返回原结果，不新增确认；内容变更返回409。过期版本、非当前阶段或错产物返回409；非本机来源或错误actor返回403，非法字段返回400。

确认不增加任务要求版本，不修改冻结流程，不启动外部操作。接纳后的 `approval.resolved` 事件保留 actor、确认正文和精确阶段身份，唤醒 Owner 决定是否推进；每个后续 confirmation 阶段必须单独确认。任何未收到的用户回复都不能构造为确认请求。

## Web Run 预算续行接口

`POST /tasks/{taskId}/continue-budget` 沿用阶段确认的本机来源和受信 `webActorId`，通过 `submitWorkflowTask` 耐久接纳。请求是严格对象，仅允许：

| 字段 | 约束 |
| --- | --- |
| requestId | 非空字符串，最多 200 字符 |
| continuationText | 用户明确续行正文，非空字符串，最多 16000 字符 |
| budgetBinding | 原样提交当前任务投影的 `budgetContinuation`，严格对象 |

`budgetBinding` 必须包含非空字符串 `taskId`、`controlState`、`stageId`、`runId`、`workflowDigest`、`nodeRunId`、`nodeId`（每项最多 200 字符）；正整数 `requirementRevision`、`planRevision`、`generation`、`maxClaims`；非负整数 `controlRevision`、`runRevision`、`leaseEpoch`、`claimCount`。主体 taskId 取自 URL，服务与控制账校验绑定 taskId 一致。客户端不得传入 actor 或任意追加额度，也不能拼造不存在的用户授权。

Host 按剩余节点数 × 3 计算额度，同 Run 只准一次，保留原累计次数、候选与已完成验收。重复相同请求读回原回执；内容冲突、过期绑定、已续行、非预算等待或其他续行门禁失败返回 409（`RUN_BUDGET_CONTINUATION_*`）；受信来源或 actor 失败返回 403；非法字段和正文返回 400。202 代表接纳，不代表后续节点成功。再次预算耗尽不自动续费。

## 任务汇总与当前完整详情

`GET /state/tasks` 对原生工作流任务按持久化的 `task.web-rerun.accept` 关联树汇总，每项只返回一张卡片；已有卡片字段来自最新可读执行。已有历史并发分叉仍取活动执行，避免隐藏未结束工作。仅分析任务及同标题但无明确关联的任务保持独立。旧版任务沿用原有记录模型。

- `GET /state/tasks/{taskId}/detail`：旧链接和当前链接均返回最新可读执行，`requestedTaskId` 为请求的入口，`taskId/latestTaskId` 为当前物理执行，`logicalTaskId` 为可读逻辑任务。`executionNodes` 按当前计划全部阶段及节点顺序返回；每步带稳定 `stepKey`、`stageId/stageTitle` 和真实执行/产物引用。仅取各运行当前有效节点，不拼历史代次；计划移除的阶段不再出现。尚未绑定定义的阶段返回 `definitionPending=true` 占位，`plan.stepsResolved=false`；无计划或尚未初始化时没有杜撰步骤。
- 详情带 `detailRevision`，依据计划、需求、Owner、运行/当前节点及效果账生成，累计时钟不改变版本。投影前后版本变化重读，持续变化返回 409 `TASK_DETAIL_STALE`。需求尚未被当前计划接纳时，`plan.requirementCurrent=false`，旧步骤显示待确认且不暴露旧结果正文；后续未执行阶段也不会将前段旧成功作为当前结果。
- `GET /state/tasks/{taskId}/executions?offset=0&limit=20`：按执行接受顺序倒序分页，返回 `{rootTaskId,latestTaskId,total,executions,nextOffset}`。每项含 `taskId`、`executionNumber`、状态、目标、时间、结果、归档时间及 `stageOutcomes`。阶段结果来自该次全部运行，失败后重建不会覆盖失败记录。结束时 `nextOffset=null`。
- 原有 `/state/tasks/{taskId}/runs` 仍为单次执行内部的运行历史，不等于整项任务的历次执行。

offset 必须为非负整数，limit 为 1–100 的整数；参数错误返回 400。请求的执行不可读或不存在返回 404。先按配置群范围和 Web 身份过滤，再编号、计数及分页，不通过祖先信息泄露不可读记录。

`executions` 和 `runs` 保留为内部只读恢复/排错接口，任务详情不加载或展示它们。新的追加、取消、重执行及归档从最新执行发起，陈旧操作身份返回 409 `TASK_EXECUTION_STALE`；旧详情链接的映射不替陈旧写请求换身份。同一已接纳请求仍可幂等回读。重执行核对整个关联任务的终态、租约和外部效果。最新执行在首个运行前取消时，重执行请求必须显式传 `expectedRunId:null`；存在运行时必须传精确最新 runId，省略该字段不合法。开发分支从已登记的明确祖先继承，不创建猜测来源。

归档在原生事务中核对全部关联执行均已完成或取消，Owner 完成已应用、运行终态、租约及效果排空后，一次记录全部成员；任一成员不满足条件则整项失败，不部分归档。历史和产物不删除，不迁移 schema。

## 本地部署维护与原子停机许可

这些接口仅接受本机连接及现有可信 Web Origin，写入身份由 Host `webActorId` 注入，不能从请求体提供。

- `GET /runtime/maintenance`：返回 `active`、`phase`（`inactive|draining|stopping`）、`revision`、`maintenanceId`、`busy`、`drained`、`processIncarnation`、`stopPermitted`、`resumePermitted`。`processIncarnation` 为 Host 启动时生成的 `PID:UUID`；同进程开库或模块重载不会改变，HTTP/Store options 不能设置。
- `POST /runtime/maintenance`：`{requestId,active,expectedRevision,maintenanceId,reason}`。进入 `draining` 后阻断新领取，允许已开始的操作排空。普通 `active:false` 只能退出未封存维护。
- `POST /runtime/maintenance/seal`：`{requestId,expectedRevision,maintenanceId,reason}`。在同一控制账事务中核验版本、维护身份、可信 actor、零活动节点/Owner/效果/消息发送，然后保存 `stopping`、`sealedIncarnation` 并递增版本。只有封存进程的 `stopPermitted` 为真，单独 `active+drained` 不再构成停机许可。
- `POST /runtime/maintenance/resume`：同 seal 请求字段。仅当当前受信 Host 进程身份与封存身份不同且仍排空，才递增版本并退出维护。旧进程不能通过普通 leave 或 resume 撤销停机许可；不得通过改变调用参数伪造新身份。

写接口返回 `{receipt,state}`；同 `requestId` 同载荷幂等，不同载荷冲突。过期版本、已封存或未排空返回 409，额外身份字段返回 400。许可与维护事件持久化，重启不会自动解除。外部只读 SQLite 检查器没有 Host incarnation，只核对持久 `phase/maintenanceId/revision`，不得自行签发 `stopPermitted`。部署脚本必须先取得并核验 seal 回执，再停止其绑定的旧 PID；新实例健康与恢复核验后调用 resume。

任务汇总GET /state/tasks的sourceGroupId是可读取关联链内的原群聊ID，无可用来源为null；仅供卡片群名展示，不替换本次groupId、授权与报告渠道。Web重新执行的groupId仍为web:actorId。
