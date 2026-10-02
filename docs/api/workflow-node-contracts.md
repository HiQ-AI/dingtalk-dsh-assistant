# 工作流节点契约

## 群常驻协调入口（当前 Workflow 主链）

消息语义的唯一入口是 `createMessageCoordinator` 驱动的原生群会话；`createMessageWorkflow` 仅负责来源接收、持久命令派发和执行恢复，必须提供 coordinator。不存在 S/R/I/IB 模型入口、judge 注入或失败后旧链回退。下文旧 Resident Topic/Goal 接口不属于这条消息主链。

- 每轮来源携带 `processing`：只读 `message.source.processing(runId)` 核验当前来源后投影该来源历次版本、命令状态及真实 `business_tasks` 存在/删除/状态，不包含其他来源正文。历史已废弃命令和预分配 taskId 不能证明 Task 已接纳。
- `group_coordinator_submit` 的 `received:true` 仅证明协调提交成功；`acceptance` 明确返回 `acceptedDecisions`、`executionPending`、命令/Task存在事实及后端权威说明。提交后尚未派发时 Task 通常尚不存在，模型须以新一轮 `processing` 或当前任务工具回读为准，不能凭旧回执忽略重放来源。
- 协调输入提供 `sourceLength`。非空 `units` 的 spans 合计覆盖完整来源；`units=[]` 表示忽略，不会把来源带入 Task。要承接的材料、补充及阶段条件须用 `fact` 单元关联同批目标并设置 `replyPolicy:none`。
- 创建任务依赖本批附件/原文时，包括创建参数中精确引用已提供的 resourceRef/fileId（即使 requiredExecutionMaterials 为空），该材料来源必须用 `fact` 单元关联同一目标；忽略或错绑来源返回 `GROUP_COORDINATOR_MATERIAL_SOURCE_UNBOUND`，整批不落账。协调提交在同一事务中解除已消费来源自身的 `source_edit` 屏障；未消费来源、跨来源或指定 Task 的屏障保持原状。
- `requiredExecutionMaterials` 只接受本轮来源、附件、历史及任务候选中真实资源引用；待取得的证据或表结构属于调查目标，不是 Task 发起前置材料。覆盖不全或虚构引用返回可修正工具反馈，整份候选不落账，不生成假材料等待。
- 群协调原生会话不设额外固定步数或墙钟超时；保留原生取消、关闭排空、当前租约和工具权限校验。Task及外部命令既有执行保护不变。
- 同一消息的独立事项按单元分别建立稳定话题；首单元仍是 `source:<runId>` 的批次关联目标，后续单元按序号区分。显式已有候选或批次来源引用仍复用目标话题。
- 同一事项每轮只允许一个 `create/research` 动作；同一单元包含多个创建动作、或同一话题重复创建，整份候选不落账。原生提交工具返回 `received:false` 和合并动作提示，模型可在同一会话轮次修正；不静默丢弃动作，也不重派已接纳命令。
- `message.coordinator.claim/bound/commit/release` 复用群账，稳定 sessionId，按 turnId/leaseEpoch 排他领取。同群新消息先持久接收并在当前轮次结束后接续，不同群独立运行；长 Task 不占用协调轮次。
- 原生只读工具读取当前候选、任务事实及精确来源材料。提交完整覆盖领取来源，并核验当前 sourceVersion、Task facts hash、topic input/context revision。来源编辑使旧领取失效；任务事实过期允许读取刷新后修正候选。
- commit 原子保存 unit/topic/command/request。工具返回丢失不撤销已提交事实，派发继续以账本为准；unknown 外部效果只对账，不重派。
- `message.coordinator` 返回本群可见 Task 的 `unconsumedTaskEvents`。Host 可领取 `sourceRuns=[]` 的本地事件轮，按真实 taskEventRefs 和 taskEventWatermarks 原子消费；此时 decisions 必须为空，不能把后台状态变成新的用户授权。事件已提交不重复投递，未提交重启后仍待消费。
- 澄清保留 Host 生成的精确候选材料快照。答复经身份核验后回到同会话；同群澄清动作只登记后续唤醒，不等待包含自身的 flight。跨轮授权仅复用同来源、相同 spans 对应的已解决请求，不重写原快照。
- 维护阻止新协调领取，running/committed 会话排空后才可封存。协调者不直接发群消息；承接、等待及结果仍走唯一持久通知出口。


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

## workflow-v2 领域准备与交付合同

本节适用于原生 Task Owner → Stage → Run 编排，不改变前述 Resident domain v9 的版本号。

### 入参和阶段准备

新接纳的 `acceptanceCriteria` 共用 `task-input-contract.js`：数组含 1–32 条，每条为字符串、原始长度不超过 2000 个 UTF-16 字符，trim 后非空；空数组、显式 null、类型错误和超限均拒绝。消息可省略该字段并沿用目标作为默认验收，工程准备也仅在字段未提供时使用 `[request]`。历史持久记录读取不套用新数量限制；Owner 追加验收同时限制当前有效项合计不超过 32 条；修订/重开在写入需求前整批预检，避免部分追加。已存在项的幂等重放不增加计数，历史累计项不裁剪。

首阶段和后续阶段统一调用 `createTaskStageContracts().prepare()`。各领域声明准备函数，按其声明核对材料角色、必需/单份约束、数量及序列化字节容量，准备后再校验实际冻结定义的首节点输入。未注册合同、材料越界或字段不合法均阻止启动，公共服务不从材料正文猜执行参数。

后续阶段的 `handoff` 为 `kind: workflow-stage-result`，包含 `contract:{id,version}`、`taskId`、`requirementRevision`、`planRevision`、`stageId`、`runId`、`workflowDigest`、`outputRef` 和 `value`。Host 核对当前计划与需求版本、同一 Task 的成功 Stage/Run、当前代最终节点及准确输出引用后构造交接。实际消费前序领域结果的准备合同声明 `consumes:[{id,versions}]` 白名单，Host 在调用准备函数前检查，不支持的类型或版本报 `TASK_STAGE_HANDOFF_UNSUPPORTED`。工程入口只接受 `agent-investigation-result@1` 与 `investigation-result@2`；原始材料独立保留，引用存在不等于类型受支持。

阶段目录的 `resultContract` 从对应 Workflow 的权威 `ownerContract.resultContract` 派生；未声明独立结果合同时使用 Owner 合同的 ID/版本。实际交接读取生产 Run 的冻结定义，目录不替代冻结合同。移除独立的 `requiredOutputs` 说明，避免维护第二套输出真相；必交文件仍由任务 `scope.artifactFiles/fileDelivery.files` 决定。

### 领域受理规范与职责

任务目标和当前有效验收项是本轮承诺的依据，领域执行规则及产物合同随 Workflow 定义摘要冻结。完成准入采用当前修正后的领域规则，并在接纳回执记录实际 policyDigest；它与生产 Run 的冻结 workflowDigest 分开保存，不借修正规则重跑历史执行。模型不能增加授权、发明专业阈值或自行修改规则；材料只提供事实，不成为执行指令。Schema 约束字段和容量，Host 约束身份、版本和状态，领域 validator 判断业务证据，提示词提供分析方法和表达指导。

| 领域 | 受理与权威输入 | 拒收或等待边界 | 合法产出与修复责任 |
| --- | --- | --- | --- |
| 调查 | 冻结任务、当前验收项 ID、已绑定材料及受信证据 | 无证据不能把事实或验收项标为满足；缺失信息保留 openItems/不足意见 | 输出事实、判断、建议及逐项意见；调查结束不承诺修复完成。Owner 安排补料或后续领域处理，调查仅修正自己的结果 |
| 工程 | 已配置仓库、明确目标与验收条件、受支持的调查交接、冻结执行配置 | 缺受信业务验收配置、实际结果、代码/方案绑定或清理证明时阻止交付 | 按冻结原需求与实际业务用例回执匹配验收项；失败按既有 `repairCurrentStage` 门禁创建新代，修复后重新构建和验收 |
| 发布/外部操作 | 已配置受信适配器、精确目标、必要批准及效果账 | 适配器未配置、准入不符或外部结果未知时不得当作完成 | 先核对实际效果，再检查本领域承担的验收项；未知效果由执行层对账原操作，不能另发一次代替核实 |
| 通用能力 | 已注册能力、授权 scope、当前分派给本领域的验收项及已核实效果 | 工具成功不证明业务满足；缺少适用检查、证据不足或检查异常均不放行 | 每次效果先核实，再检查本领域验收项；失败由能力/检查器责任方处理，不替工程或发布出结论 |
| 文件投递 | 当前必交文件、有效登记和原发送身份 | 成功发送无关文件不能满足业务项；结果未知先回读 | 核实实际投递，再检查分派的验收项；渠道仅恢复原投递，不重跑已确认业务操作 |

默认通用检查保留消息/材料整理的确定性快速路径，核对来源覆盖、报告正文和限制。其他分派项使用 `createDomainAcceptanceCheck`：通过原生 `llm.stream` 对当前领域的验收项和证据作限定判断，零工具，不新增全案总审会话；外部操作和文件投递也必须验证其分派项，不能仅凭效果成功接纳。调查使用显式 `criterionReviews`，工程使用冻结原需求和实际业务用例回执，不将这些已有领域判据替换成自由判断。存在多个工程阶段时，各阶段仅核对评估引用指向自身的条目；保留的成功前缀不承担后续新增条目，但其交付证明仍须有效。

模型检查完整传入已核验信封，不设置固定输入字节上限；输出上限 16 KiB / 4096 tokens、超时 30 秒；Host 独立核对返回 schema、逐项覆盖和证据引用。未配置模型、提供方容量错误、输出超限、格式非法、流未正常结束、出现工具调用或证据不足均拒绝接纳。扩展 `generalCompletionCheck` 仍须提供稳定的 `generalCompletionIdentity`，其身份参与规则摘要；不能用统一返回 true 的检查器扩大受理范围。夹具验证只能证明协议门禁，不能证明真实模型对业务语义判断正确。

| 责任方 | 权威职责 | 不得代替的职责 |
| --- | --- | --- |
| 业务负责人/用户 | 明确目标、判据及授权范围 | 模型不能替其放宽验收条件 |
| Task Owner | 编排已注册领域，以证据引用分派验收项，汇总已接纳结果，安排补料/返修 | 引用只表示责任分派，不能凭总结把不足改成满足 |
| 领域 Workflow/validator | 专业输入输出合同、证据有效性、合法结局及修复影响范围 | 不接管其他领域判据或渠道状态 |
| 节点 Agent | 在给定范围内分析、执行获准调用并产生候选 | 不能接纳自己的候选或修改合同 |
| Host/Controller/工具执行层 | 身份与版本绑定、状态转换、效果核实、调用领域检查并保存接纳回执 | 不用文件存在、HTTP 成功或工具成功替代专业结论 |
| UI/钉钉渠道 | 收集输入，投影权威状态，保存实际通知/文件投递回执 | 不另建完成判断；投递成功不能补齐业务验收 |

当前任务整体 `complete` 仍要求全部有效验收项满足；没有新增部分成功终态。调查可以成功产出不足意见，但若任务承诺尚未满足，Owner 必须继续处理或按既有等待/阻塞路径说明原因。

### 调查 v6 与历史定义

新 `task-investigation` 使用版本 6；输入 `acceptanceItems:[{itemId,criterion}]` 来自 Owner 的当前有效验收项，不能按位置自行生成 ID。输出保留 `outcome/summary/evidenceRefs/limitations/question`，并要求：

- `findings`：最多 64 项 `{kind:fact|judgment|recommendation,statement,evidenceRefs}`；fact 必须有证据。
- `openItems`：最多 32 项 `{description,reason,evidenceRefs}`，记录未知项和未执行工作。
- `criterionReviews`：逐一覆盖输入的 itemId，禁止缺项、重复及额外项；每项为 `{itemId,status,reason,evidenceRefs}`，status 只允许 `satisfied/insufficient_evidence/not_applicable`，satisfied 必须有证据。

嵌套证据引用必须包含于顶层证据，来源仍经过当前 Task/Run/代及受信前序引用校验。completed 调查须有证据和至少一项 finding 或 openItem。调查明确标记不足或不适用的验收项，不能由 Owner 单独改口为已满足：后续领域必须接纳同一验收项的证据；只增加备忘录或无关文件不能补齐缺口。

旧 v5 定义继续按冻结摘要注册和恢复，不把历史结果补造成 v6 结构，不静默升级已有 Run。新版本与旧版本的输入、输出合同分别验证。

### 正式交付清单与恢复诊断

`readDeliveryManifest` 从当前需求版本的成功阶段生成清单，包含阶段/Run/冻结定义、结果合同、产物引用及验收项与阶段证据的对应关系。必交文件来自 `scope.artifactFiles` 和 `fileDelivery.files`，按角色与文件名去重；核对当前需求版本、成功生产节点、登记文件及实际字节，并要求文件生产阶段具有验收证据关联。缺项、歧义、旧代文件或无法验证的文件阻止完成；要求外发的文件继续沿用独立发送回读。

完成接纳事件保存清单引用；`taskDetail.deliveryManifest` 只返回 `null` 或 `{ref,taskId,turnId,requirementRevision,planRevision}`，不展开清单全文。引用从已接纳的 complete 事件回读；与当前需求或计划版本不符时返回 null，不把旧完成清单投影为当前交付。

清单的 `complete` 仅表示结构与证据绑定通过，业务验收另存于 `businessValidation`。Host 按 `ownerContract.id` 分组，将 Owner 对每项引用的证据映射到生产领域，向该领域 `validateCompletion` 传入裁剪后的 `acceptanceItems`、`requirement`、`decision` 和领域阶段；跨领域引用不能触发跳过检查。同一项引用多个领域时，各被引用领域均须通过；没有分派验收项的阶段仍核对自己的有效输出。

所有领域检查通过后，Host 生成 `businessValidation:{status:'accepted',policy:'domain-items-v1',items}`，记录验收项、证据及 validator 的阶段/Run/冻结定义/合同版本和实际验收 `policyDigest`。实际准入规则摘要与生产 Run 的 `workflowDigest` 分开保留。回执绑定本次 decision 和结构清单摘要，候选或清单变化后不能沿用；未经过本次检查时状态为 `unverified`。Owner 完成接纳要求已接受回执，并随最终清单持久化；模型不能自行填写回执取得许可。

数据变更当前完成策略为 external-result v5：各阶段只接收验收项显式引用的本阶段证据；浏览历史时返回批准、执行及当时回查的原始证明（timeScope=at-execution），承担当前验收项时另作实时回查（timeScope=current-acceptance）。旧v4策略源码及执行定义保持冻结，Host完成准入采用当前v5；不能通过修改旧函数或旧rulesDigest使已落盘任务失去定义。新v5同样必须经专用原生证明校验，不得退回通用领域合同。

原生批准执行证明可包含presentation：仅来自实际批准前的投递事件，绑定原request/effect/审批人/收件人/正文摘要和消息身份，批准后撤回审批提示不抹掉历史呈现。没有记录时字段缺失，不用新生成文案补造历史。生产verification保留Host实际执行过的原始目录观测及范围，语义验收不能只拿passed或空数组猜测；也不得将Host已准入生产只读源擅自扩大为主库权限要求。

新通用阶段使用 Workflow v6 / Owner 合同 v2，外部操作使用 Owner 合同 v2，文件投递使用 Workflow/Owner 合同 v2。每个效果仍独立核实，同领域只检查其分派的验收项，不要求整理材料阶段验证整个工程目标，也不因计划含其他领域而跳过。旧工厂保留原定义和摘要以恢复已冻结 Run；Host 仅在完成准入时采用当前修正规则，不改写历史执行/产物、不重跑副作用。结构清单、领域业务接纳和实际渠道投递是三份独立证据，PR、HTTP 成功或非空文字本身不是业务验收结论。

持久 `execution-failure` 工件增加 `recovery:{category,responsibleParty,nextAction}`。类别包括输出可修正、业务校验、任务受阻、缺输入、缺环境、外部结果未知、暂态执行和实现错误；未知错误归实现维护。Schema 错误仅在输出校验边界归为结果修正，输入映射错误不能据此让模型重试。分类只指明责任和下一步，自动重领仍受既有错误白名单、预算、退避、控制状态及效果账限制；外部结果未知先对账。旧诊断缺少 recovery 字段仍可读取，不补造历史分类。

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

## 持续执行与取消

Run 不设累计领取上限；`claimCount` 仅为统计。已删除 `continue-budget` 接口、`budgetContinuation` 投影与 `maxClaims`。正常执行持续至节点结束；暂态故障按持久依赖状态恢复，真实输入或权限等待不消耗失败机会。受信用户取消仍校验来源和当前版本，并取消 Owner 与节点会话、确认排空。

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

任务投影topicRefs由创建命令的消息单元unitId和sourceKey对应持久话题绑定解析当前话题，包含groupId/topicId/revision/title，校验话题群与执行来源一致。汇总卡片在本次无绑定时继承可读取原群任务的topicRefs；不改本次执行groupId。无真实绑定返回空数组，不可读取原任务不得继承其话题。

话题路由纯闲聊可提交units=[]和非空ignoredRefs；每条忽略记录必须有逐字原文quote和非空reason，Host继续验证原文完整覆盖。空事项且无忽略记录、仅覆盖部分原文、未声明如何替换已有事项均拒绝，不创建Topic。

消息S节点支持 `{kind: "no_action", reason, coverage: [{start,end}]}`：仅用于无待办的语义判断，Host核对全文覆盖与成功S节点后结束；不建立事项、话题或任务。若冻结来源保存了 `replyObligation.required`，通知 Host 仍履行一次回应义务，不能把无任务等同无需回应。message.no_action不接受有事项/命令/待补请求/屏障或修订的运行。

收信箱 `workflowStatus` 区分 `waiting_clarification`（用户需补充）、`waiting_context`（助手读取材料）、`waiting_system`（真实系统阻塞，需恢复依赖）；真正处理失败仍为 `routing_blocked`。`waiting_routing_barrier` 仅表示当前事项的相关输入待核对，不表示全群排空。`workflowStatusDetail` 保留实际问题或原因。

每条消息另外返回以下只读事实，不以通知是否送达改写业务处理状态：

- `waiting[]`：`requestId/unitId/goalText/kind/responsibility/reason/blocked/attempts/retryAt/recoveryCondition`；系统故障及范围等待可无 requestId。事项局部失败包含 unitId 与 goalText，不把同一消息的独立事项列为全局故障。责任 `host/requester/system` 分别表示助手取证、请求人补充、维护排查；审批或验收责任沿请求中已有值保留。
- `blockingSources[]`：当前事项待核对来源的 `runId/sourceKey/sourceVersion/messageId/text/reason/topicId`，由同一作用域查询给出，不将全群未关联消息一律列为阻挡。
- `notifications[]`：`notificationId/phase/status/acknowledged/delivered`，状态保留 prepared、sending、acknowledged、unknown、delivered、superseded。ACK 不等于独立回读；unknown 只先回读，不能凭查询失败重新发送。空数组表示尚无记录，不等于已告知或无需告知。

任务接纳与持久承接责任在同一事务保存；即使命令完成回执前中断，仍可从原 acceptance 事实恢复通知。模型 `replyPolicy=none` 只控制可选回应，不取消任务承接及 Owner 生命周期沟通。用户静默必须有当前来源原文且限定助手沟通及进度/结果范围；数据库方案“不发送消息”不扩张为助手永久静默。准备和领取均检查当前事实版本，过时 prepared 通知失效；已发送或结果 unknown 的通知仍保留原账等待回读。


### 内部材料受管重试

`POST /workflows/:runId/requests/:requestId/retry` 仅接受本机回环地址、允许的 Origin 与已配置 Web 操作者身份。请求体为 `{sourceVersion, reason, dependencyRevision}`，不得提交 actorId 或伪造材料正文。只可恢复当前来源版本下处于 pending 且有真实读取失败的内部 `needs_context`；业务澄清仍走原 `/answer`。

`dependencyRevision` 记录本次能力修复或材料更新的明确版本，相同版本不重复清零。保留原 request 身份及 retryHistory，清除 blocked 后调用真实材料读取恢复；返回 request 的实际状态，重试不保证 ready、不重放 Task 或外部效果。不允许定时器自行更换版本无限清零。

阶段 `sourceCondition` 保存来源键/版本/逐字引用、阶段 objective 和必要的 requiredActorId。同一 Task 的不同数据集合使用不同阶段目标；人工确认必须同时绑定条件摘要、当前要求版本、前阶段输出和指定发送人的当前消息来源。阶段规划许可不替代生产 adapter 的精确执行批准。


### 完整消息材料输入

群常驻协调输入、Owner 来源事件与阶段材料交接不设置应用侧固定字节上限。已授权的材料正文、来源摘录和显式读取的 Task 历史完整传递；不再以 12/16/32 KiB 拒绝，也不强制先经模型摘要。候选卡仍可摘要，但明确材料读取返回完整原文。连接器报告不完整、来源或版本变化时仍不可作为执行依据；Owner保留完整来源及事件，事件目录仍按查询游标读全；材料角色、数量、来源版本与执行授权校验不变。实际模型提供方容量错误保留为可恢复的系统阻塞。

来源快照中的 `replyObligation` 是可选证据；缺失时不能伪造点名或回应责任。当前来源由群常驻会话处理，不再领取旧 S 节点。


协调动作的 `stageAuthorizations.sourceQuote` 必须连续引用当前来源原文，`objective` 必须是该 quote 的逐字连续子串。Host 准入独立核验来源、身份和精确阶段合同，非法候选不得创建效果命令；生产执行仍需要既有 adapter 的精确批准。


历史 `hN` 仅用于 S 的短引用。进入事项上下文时，Host 按冻结 `historyManifest` 解析成真实来源键；R 读取材料与 I/IB 的 `executionMaterialRefs`、Task 固定材料使用同一真实键，不把短别名留给后续连接器。

`facts.actorMayCreate=true` 是 Host 已核验的任务准入事实。I/IB 仍判断原文动作意图，但不因同一交办没有再次点名而重复询问是否承接；准入不代替生产执行或审批授权。

通知按稳定 `eventKey` 查询同一 Owner 报告已有账目，已有通知的原来源引用、发送及回读事实保持原样，不因后来 command 或投影字段变化重发。`message.notification` 查询须且仅须提供 `notificationId` 或 `eventKey`。

通知扫描逐来源、请求、承接、命令、Owner 报告及投递事实隔离异常；准备失败不阻断其他 prepared 投递或 unknown/acknowledged 的只读回查。失败落在原 `message_items` 的 `notification-diagnostic`，通过现有 `message.run` 状态返回 `notificationDiagnostics`（id/runId/fact/error/status/attempts/createdAt/updatedAt/resolvedAt），并可用 `message.notification.diagnostics` 按 runId/status 查询。相同未解决错误不重复写账；事实恢复后标记 resolved。内部 flush 完成其余事实后仍汇总抛出诊断供既有恢复日志显示，不将失败冒充成功。

### 只读问答原命令重试

`POST /workflows/:runId/commands/:commandId/retry-readonly` 仅接受回环来源、允许的 Origin 及配置的 Web 操作者。请求体 `{sourceVersion, retryKey, reason}`，禁止传入 scope、输入 artifact 或执行身份。Host 重新核验当前话题与冻结附件的精确来源，准备新输入及新会话，再以旧输入版本、摘要和租约做原子 CAS。

仅可重试已落账 blocked、实际执行 failed/drained/read-only 且原因为 `execution_tool_failed` 的 answer；来源过期、成功、未排空、未知效果及运行中通知拒绝。保留旧尝试、旧失败回执，原 commandId 不变，新执行增加 inputVersion 并生成独立结果通知。相同 retryKey/reason 返回已接受结果，不再次执行；更换 reason 必须使用新的明确操作键。维护期仍遵守现有执行领取门禁。返回 HTTP 202 `{runId, commandId, inputVersion, accepted, cached?}`；接纳重试不等于查询成功。

只读answer完成事务将执行inputVersion固化于command.result.inputVersion。结果通知正文与版本来自同一命令结果快照；receipt fact携带commandLeaseEpoch，准备及领取均核对当前已完成命令的租约和inputVersion。旧失败快照不能占用新执行结果的通知身份。

### 原来源阶段授权投影修复

`POST /tasks/:taskId/repair-stage-authorizations` 仅接受本机 Web 身份。请求：`repairKey`、`reason`、`expectedRequirementRevision`、`expectedRequirementRef`、`stageAuthorizations[]`；每项必须有 `workflowId/sourceKey/sourceVersion/sourceQuote/objective/gate`，gate 为 `none` 或 `confirmation`。确认人由原来源 actor 绑定，调用者不能替换。

入口只替换既有 requirement 的 stageAuthorizations；逐字核对当前原来源并在事务内复查版本、actor、正文摘要及旧 requirement CAS。只允许没有外部阶段/效果、运行或未排空执行的只读任务；旧Task、失败和回执保留。固定 `authorization.projection.repaired` 事件的 payloadRef 保存原/新requirement引用、来源摘要及修复原因。同repairKey同参数回读原结果，异参冲突。

外部阶段的授权必须明确 objective 和 gate，二者与计划精确匹配。缺字段的历史授权不能作为通配授权；sourceInstructions 原文仍保留供只读调查及审计。这是遗漏投影修复，不是用户新要求或审批批准。

授权投影修复使 requirementRevision 递增而旧 planRequirementRevision 保留。后续必须走 Owner 正常重评计划，保留失败旧run并建立同Task新阶段；`retry-investigation` 在两版本不等时拒绝，即使调用者携带新的CAS也不能复用旧计划。未改变requirement的纯读取范围修复仍可原run重试。

### 只读 Owner 再评估

#### Owner 驱动的节点续行

Host 的 `Controller.inspectNodeRecovery(runId)` 返回 `mode=resume-agent`、当前节点身份、原始失败、诊断引用及准入结果；`reason=strategy-change-required` 表示同一节点/输入/问题已有受管续行，不能原样重放。该能力由既有 `repairCurrentStage` 决定驱动，不增加 Web 接口或模型写控制账工具。

`Controller.resumeNode` 接受 commandId/runId/expectedRevision/nodeRunId/generation/leaseEpoch/inputDigest/contextRef。上下文来自已读诊断，绑定 task/run/node/generation、诊断时 requirementRevision/planRevision/controlRevision、修复方向及证据；Controller 读冻结定义和工件，Store 同事务核对版本、来源、维护、排空、输入围栏和效果。仅当前可纠正的 pure/read Agent 节点准入；原node/session/generation/输入及成功前缀保留，下一领取递增lease。`node.resume` 保存旧诊断与上下文；接管到更高lease仍可读取该上下文，直到输入或节点替代。审批、code外部动作、未知效果及真实权限拒绝不经此入口。

Owner 有受信恢复能力时不得仅wait/block而消耗事件；原始诊断未实际读过则以可纠正反馈返回。重复无效决定仅结束当前思考轮，并沿持久退避在原会话继续，未处理事件保留；动作指纹忽略summary及condition解释措辞。真正的审批等待继续由原审批事件唤醒。

`POST /tasks/:taskId/reassess-readonly` 仅本机 Web 身份且有任务访问权可调用。参数仅为 `recoveryKey/reason/expectedOwnerRevision/expectedLeaseEpoch/expectedRequirementRevision/expectedControlRevision`。禁止传入材料、权限、替代 requirement 或来源正文。Host 按当前 requirement 验证材料可读范围与旧 scope 缺口，记录固定 `system.recovery` 事件；这不证明远端查询成功。

仅 active 控制态、idle/blocked Owner 无在途决定、存在已失败/等待/成功的只读调查、所有节点排空且无 pending input、外部阶段或 effect 可接受。计划阶段全部成功不代表整个任务完成；当前要求和计划已有已应用的 Owner complete 决定时拒绝重评。事务 CAS 与来源摘要复查；同key同参数回读，异参冲突。保留 Task/session、requirement 和已有产物；Owner 接收新事实后正常决定计划与执行，不把系统恢复等同于新业务要求、测试确认或审批。恢复工件保存 previousDecision 的 action/condition/applicationStatus/lastFailure，以区分业务条件及系统诊断。

新 Owner wait/block 必须提交 condition，字段为 kind（business-input/approval/capability/permission/execution）、missing、responsibleParty、resumeWhen、evidenceRefs。condition证据必须包含于决定的evidenceRefs；其他动作不接受condition。候选与最终接纳共用状态校验，最终事务仍复核版本、权限和完成证据。成功阶段后可等待整体目标条件或追加后续计划；已成功和运行中的阶段不因条件登记而改写。业务条件用于说明所需行动，满足条件仍须通过受信事件及正常授权检查，不构成自动生产执行批准。相同候选因同一合同再次被拒绝时保留诊断并结束当前思考轮；按持久退避继续纠正，不把内部异常视为业务任务终止。

`reassess-readonly` 可在同一事务中原生discard已知无效果的非法 `repairCurrentStage` 动作：仅当前租约的 application blocked 且 Owner 最后错误严格等于 `WORKFLOW_REPAIR_NOT_ADMITTED`。仍要求完整CAS、只读失败排空、无effects和其他在途动作。其他错误或pending动作拒绝；返回 `discardedTurnId`，原decision、应用失败次数、报告仍保留为discarded，再记录system.recovery。不修改requirement。

系统错误通知仅在需要人工介入、自动恢复无法推进时发送，固定为“处理遇到系统问题，无法继续推进，需要人工介入。”，按群职责加代回署名。内部读取重试、可自动恢复的deadline/容量重试不发送该通知。同阻塞不因technical reason或消息版本变化重发；Owner应用受阻以同Task上一次已成功工作流事件分隔阻塞，不能靠重复Owner轮次再次发送。实际归类等待只给简洁核对进度，不复述来源正文或添加“无需重复提交”措辞。文案升级不补发历史通知。

系统等待通知的准备与领取均检查仍可自动推进的命令、节点及材料请求；材料读取仍可自动推进或仍有在途工作时不发送人工介入提示。Owner 应用阻塞通知领取在同一事务内检查同 Task 自最近 workflow.succeeded 以来的 sending/unknown/acknowledged/delivered 通知，重复 prepared 不会再次外发；旧 report 仍须通过最新报告及需求版本校验。

通知回读不再允许任意包含预期正文：完整正文须匹配，仅当引用消息 ID 和会话匹配原来源时，允许移除回读中的单个 `@引用发送人 ` 前缀；短正文同样适用，额外正文或错误发送人仍拒绝。已删除 Task 必须有 `task.deleted` 审计墓碑，扫描停止生成承接及生命周期通知，prepare 拒绝 TASK_DELETED，claim 将相关旧 prepared 标记 superseded；未知真实缺失不按删除处理。

Owner真实阻塞释放而未产生report时，通知仍读取真实Owner阻塞事实：Owner须blocked、无当前turn、最后turn为未接纳的released，Task控制仍active且无pending/ready/running阶段。通过现有owner:application_wait唯一出口使用固定人工介入正文；准备和领取均复核，不伪造Owner报告。暂态重试不告知，恢复前同阻塞只告知一次，实际成功后的新阻塞可开启新一次。

PR预检暂态失败仅在Host适配器通过完整本地日志独立证明同一冻结操作从未发送时进入持久退避。原节点新lease恢复同effect，原生事务核对失败收据、冻结摘要、操作身份、权限、资源占用及安全屏障后重新取得发送许可。已有send-intent、结果未知或无完整证明时只对账，不重新发送；模型不能提交未发送证明。每次dispatch lease独立记录观察收据，避免重复失败结果被旧回执吞掉。

### 原 Task 的明确需求修订与原生数据库审批

本机已有 `POST /tasks/:id/context` 可选传 `requirement: {objective, acceptanceCriteria, stageTargets, stageAuthorizations}`，与 `context`、`requestId`、`inputVersion`、`runSequence` 一起使用。objective 必须包含在实际 context 中；阶段授权包含 workflowId、sourceQuote、objective、gate。服务核验当前操作者和目标白名单，将本次真实 Web 指令记录为新来源，保留原始来源及已冻结运行，不伪造群成员发言。原请求的比较版本和幂等约束仍生效。该入口不构成生产 SQL 批准。

`task-data-change` v4 的原生审批等待保留 `waitReason.kind=recovery` 以复用现有对账恢复机制；reference 为 `BYTEBASE_APPROVAL_PENDING` 或 `BYTEBASE_HUMAN_APPROVAL_NOT_CONFIGURED`。投影展示真实等待事项、责任方及恢复条件。驳回产物为 `outcome=needs_revision`，携带工单、SQL、真实意见和证据，后继同 Task 的候选绑定 previousIssueId，必须重新取得审批。新默认调查合同为 v9，v8 及以前保持原摘要恢复。

已有调查 Run 或全部调查阶段成功不封闭原 Task 的需求修订。取消控制或当前需求与事件水位已应用的 Owner complete 才拒绝 context；无 Owner 的历史 Task 仍按业务终态判断。原生审批的两个等待代码复用外部效果只读对账路由，未批准不恢复执行，批准/驳回后原 Run 接续，禁止重新发送未知写入。
明确 requirement 修订的验收清单与目标在同一事务更新；从真实 pending Web 事件读取并核对完整输入摘要、操作者、来源和比较版本，旧验收保留 inactive。普通 context 追加仍保留原验收。
任务阶段来源验证、Host task.source 查询及只读重评/授权投影修复共享当前真实来源解析。Web 修订仅在实际持久 accepted 后生效，绑定 Task、actor、sourceVersion=1 与实际 context；跨 Task、篡改版本/引用/操作者拒绝。DWS 仍要求当前消息版本，旧成功成果不改写。

来源校验修复后的 advance 拒绝决定可由同一 reassess-readonly 审计恢复：必须为当前租约和需求版本、错误严格为 TASK_STAGE_SOURCE_CONDITION_INVALID，真实来源重新校验通过，仅已排空成功调查，无外部效果及计划应用回执。旧决定 discarded 并保留报告和失败历史；返回 discardedTurnId，需求、成功阶段与 outputRef 不变。其他拒绝原因不自动重发。
## 数据变更审批渠道交接

`POST /tasks/:taskId/handoff-data-change-approval` 仅本机同源Web身份，并沿现有任务访问授权。body严格接受runId、recoveryKey、reason、dryRun及expectedOwnerRevision、expectedLeaseEpoch、expectedRequirementRevision、expectedControlRevision、expectedPlanRevision、expectedRunRevision、generation。Run revision可从0开始；其余范围遵循原生领域版本。dryRun返回checked/authorized且零写，apply返回accepted及resumeWorkflowId。

先用现有context修订需求与活动验收，当前同Task最新真实来源明确授权插件审批并登记task-data-change-approval-resume目标和来源条件；context只修订业务Task，不向未知效果的冻结Run插入pendingInput。交接只允许旧v5原生纯审批gate、成功前缀、排空及无其它未知效果；受信Host再次证明准确SQL/目标/工单仍未执行。apply通过原生观察关闭旧审批读取、原生stop取消旧Run，并投递approval.channel.changed事件让Owner只替换后段。事件附固定resumeWorkflowId和动作说明，不重新建单。

同recoveryKey绑定完整请求摘要，重复幂等；原生stop收据允许同请求在停止后继续，任意其它版本漂移仍拒绝。维护、租约、需求/控制/计划/运行漂移、来源错误、跨Task、已有执行及未排空均拒绝。完整条件留详情，群只给简短待审进展。

Owner已接受但尚未落地的决定，仅当它准确替换当前后缀为一个已有工单接续阶段，且来源绑定当前需求时允许交接。取消旧Run后先持久化渠道变更事件，让旧待落地决定因水位变化失效，再推进计划；事件后中断的同请求重试补推进计划。其它待落地决定和正在运行的Owner仍拒绝。

审批列表的目标使用当前业务需求，SQL、数据库及工单仍来自冻结审批效果；需求文字修订不改写已提交包。群中数据变更待审通知只在当前阶段有准确工单绑定、prepared效果及pending插件审批时生成“Bytebase 工单 #编号 已新建，等待人工审批。”；完整SQL和恢复条件留详情，其它等待仍展示实际简要原因。
