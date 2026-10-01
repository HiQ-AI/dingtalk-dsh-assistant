# 群消息协调主链简化评估

日期：2026-10-01。状态：用户已批准实施；运行切换及真实历史验收记录在 acceptance/message-processing-20260930。本文是开工前方案快照。

## 目标与当前证据

同一事项持续补充时，能够承接并推进同一 Task；无关闲聊不主动澄清、不阻塞任务；进度只按真实业务变化通知。保留任务持久化、审批、恢复和外部效果防重。

现行 S、R、I/IB、Owner 分别解释不同投影中的用户意图。S 判断是否交办，R 再校验受话者和任务关系，I/IB 生成动作，Owner 解释目标和阶段。身份及原文在各输入中的差异已造成实际误判。代码依据：message-model.js 的 S/R/IB 提示、message-context.js 的 splitContext/unitContext、message-workflow.js 的 drive/unitDrive、task-owner-session.js 的 Owner 提示。

实际反例包括重复 Task、重复承接、无关追问触发澄清、输入等待消耗 Owner 失败次数、Host 已确认点名但 R 丢失身份。前述故障足以说明当前主链需要简化；缺少旧方案处理同批消息的可比较记录，不能据此量化新旧稳定性，也不能证明所有故障都来自架构。

反证边界：通知回读当前另有确定性实现错误——引用回复添加 @前缀后，短正文不能通过 sameDeliveredText 的长度条件，造成 acknowledged 长期不结束。该问题在常驻会话下也可能发生。旧方案文档 checkpoint-review-deduplication.md 同样记录过重复审阅，不能把旧方案视为天然可靠。

## 三个候选

| 候选 | 判断 |
| --- | --- |
| 保留多阶段语义主链，继续逐处补齐上下文与守卫 | 不建议作为长期方向；每处修改继续承担多份输入投影、阶段状态和恢复路径的一致性成本。 |
| 整体回退旧常驻运行时 | 不建议直接操作；旧实现仍有历史故障，且当前 Task、审批、消息和效果记录不能丢失或被重建。 |
| 群常驻协调会话 + 现有持久 Task/执行后端 | 建议；让连续理解归一个协调者，确定性约束保留在已有 Host 和账本中。 |

## 建议的唯一主链

消息持久接收 → 群常驻协调会话 → 已有任务工具与执行后端 → 业务状态事件 → 统一通知出口。

1. 每个群保持一个逻辑协调会话，连续读取身份、群职责、原消息、附件及当前任务。允许原生上下文压缩和从账本恢复，不能把“常驻”理解为永不压缩的无限历史。
2. 由协调者完成是否需要参与、关联哪个 Task、查询或补充还是新建、是否真正需要澄清的判断。S/R/I/IB 不再作为每条消息必经的独立模型阶段；不再让后续阶段重新判断是否向助手交办。
3. 同一轮可通过工具读取材料及任务事实，再提交动作；不是要求一次模型调用猜完全部信息。沿用原生会话与工具能力，不新增平行调度器。
4. 协调者承接后即释放群消息处理，长任务由已有 Task Owner/执行会话推进。任务事件回到协调者；某任务等待材料不占住群消息队列。
5. Owner 负责已承接任务的执行计划和验收，不再次判断群消息是否应该承接。需求变化由协调者通过既有任务接口写入，Owner 使用同一份持久需求。
6. 保留确定性的来源去重、Task 身份、版本校验、权限、审批、取消和外部效果回执。提交基于旧版本时只刷新受影响任务后重评，不重跑整群拆分关联链。
7. 承接、需要用户补充、需要人工介入、阶段进展和完成走唯一通知出口。内部重试不产生群通知；人工介入按一次阻塞事件只通知一次，文案遵循用户已经明确的简短规则。

## 实施与迁移边界

- 优先复用当前原生会话基础和持久 Task API；不能直接关闭 workflow 配置使当前群回落旧引擎，resident.js 已有切换封存约束。
- 现有 Task ID、消息消费位置、审批及已发送消息记录原样接续；新增主链不能重新执行已知外部效果。
- 未判定输入需进入同一协调入口；已经提交的命令继续按原记录收口。新旧入口不同时消费同一来源。
- 当前已确定的通知回读和已删除 Task 投影错误仍须修复，它们是共用基础能力缺陷，不能依靠更换会话掩盖。
- 拆分、关联历史保留为历史记录；不要求把历史所有消息改写成新结构。

## 验收

以本次真实消息序列为主线，验证文件与后续请求、70 条状态查询、69 条方案、2 条测试与验证后正式执行、更正专家列、无关人际追问、两份 SQL 与明确审核交办。每个输入应有明确处理结果，同一业务任务保持一个身份。

额外覆盖消息重复到达、处理时收到取消、重启接续、任务缺材料而其他任务可处理、发送成功但回读延迟。测试与离线历史比较均禁止产生真实外部效果；实际恢复继续使用原来源和原任务，并独立核验群消息与业务状态。

完成标准是实际请求被正确承接、等待可解释且可恢复、群内通知符合要求；减少阶段数和本地测试通过都不能单独作为完成证据。

## 原生协调事务契约

协调状态复用 `message_groups.body.coordinator`，不新增表。`message.coordinator` 查询返回 group、coordinator 和当前未消费 sources；游标只记录已接纳位置，不据此跳过较早等待来源。已有 command 的来源继续原派发，不重交模型。

Host 通过 `coordinator.claim` 提交 current source runs、expectedLeaseEpoch 和 turnId；群 sessionId 稳定，bound 独立落账。commit 在同一原生事务检查来源版本、群 lease、已有 Task facts hash、已有 topic input/context revision，保存既有 unit/topic/command/request，并封存旧判断节点与待处理请求。空 units 表示无动作。等待请求在真实 resolve 后重新进入同一入口。commit 后 lease 仍有效，只有 drained release 才释放；进程重启撤销旧 lease，已提交命令不重建。

同批话题关联全部写入后，命令统一绑定最终 inputRevision。已删除 Task 不能再次成为命令目标。影响账记录已决定的 topic 范围；尚未决定的新来源仍保留现有执行屏障。本地事务测试不代表真实群语义或完整主链验收。

维护入口将 `message.coordinator.claim` 与既有派发一起禁止；维护 busy.messages 直接计入群账 running/committed 状态。已提交动作但原生 session 尚未 drained 时不能 seal。commit 更新当前话题 processedRevision，wake 同源 coordinator 请求时清除 consumed 标记；普通等待恢复扫描不重新提问。

## 2026-10-01 用户授权问题批次精确清理

范围由 manifest 明确 runIds、sourceKeys、taskIds、topicIds，必须列全同源版本，不按群或时间推断。用户指定的问题消息 109–115、128、130、132–134 及两项既有 Task 的实际标识由只读账本枚举确认，工具不内置序号映射。未确认 live 清单前不得执行。

先通过既有原生取消/排空及 task.delete 删除仍存在的目标 Task。清理命令拒绝残存 Task、未知通知、其他 Task 引用或外部待处理屏障；已删除重复 Task 保留其删除审计。离线 stopping/drained 后 `node scripts/cleanup-message-batch.mjs --check <manifest>` 零写检查全部版本、话题绑定及通知。manifest 另含 dbPath、instanceId、expectedPid、maintenanceId、maintenanceRevision、notificationAuditPath。核验输出的 sentNotifications 单独保存为撤回审计 JSON，独立读回后把 expectedDigest、notificationAuditDigest 加入清单；这不是库备份。

旧进程退出后 `--execute` 通过原生 owner 独占锁、再次 CAS 检查并调用 message.batch.cleanup。只删指定消息 items/runs/sources 与 bindings；话题无剩余绑定才删除，有其他来源时保留话题，只移除引用已删除来源的事实。DWS 原消息历史及文件身份保留，供新主链读取和重放。执行回执、事件、文件和会话审计保留，不重发旧命令或旧通知。重放使用新 runId/commandId，不能复用旧幂等 receipt，也不能复用已删除 Task 的派生 ID。

本地已验证全版本闭包、维护门槛、审计摘要拒绝和其他事项保留。尚未执行真实清理；Task 原生取消前置条件及实际清单需独立验证。

群协调查询同时返回同群原始 Task 来源对应的 `unconsumedTaskEvents`。claim 可用空 sourceRuns 与非空 taskEventRefs 领取后台事实；seq 必须属于存活 Task 的真实同群事件，且不得跳过该 Task 尚未消费的前序事件。commit 在同一事务再次核验并推进现有群 JSON 的 taskEventWatermarks；纯事件轮 decisions 必须为空，不产生用户动作或新授权。重启未提交事件仍待消费，已提交事件不会重复进入；维护排空沿用同一群状态。

协调提交的 `unit.topic.factRevisions` 沿用原合同：每项 `{factId,sourceQuote,scope}`，sourceQuote 必须为当前原文，fact 原作者与当前发送人一致，撤销/替换表达明确且 scope 是当前话题或整条条件；含局部限定时拒绝扩大为整条变更。已有 topic 版本先 CAS；更正在同一事务、新 facts/commands 之前执行，保留其他条件。既有账本与协调入口共用同一个更正函数，不恢复 IB 模型链。


## 2026-10-01 后续明确决策：唯一入口与授权重建

用户明确要求不保留旧判断链兼容。实施边界调整为删除 S/R/I/IB 在线模型入口及其 fallback，消息来源、命令、执行和通知继续复用现有持久后端；测试改为原生群会话与真实账本合同，不以旧 judge 适配新接口。

用户另明确授权清理本次问题批次的两个旧 Task 和相关消息记录，并撤回旧回复后按新架构批次重处理。此授权仅限上节 manifest 精确列出的来源全版本、内部记录及两个 Task，取代本批次“必须继续沿用旧 Task”的早期决定；不扩大为其他群或其他任务清理，也不批准生产 SQL。DWS 原来源和附件身份继续作为新批次输入，不能把系统旧回复当作新业务需求。清理执行结果与部署后业务重放分别记录于 round-31，不将清理成功视为业务已完成。

## 首次 Owner 计划与候选校验

新 Task 的 planRevision=0、planRequirementRevision=0 是尚未建立计划，不能因其小于 requirementRevision 就给 Owner 注入 replaceSuffix 指令。只有已有计划且计划要求版本落后时才要求重评后缀。首次阶段使用 initialize；已有计划不能重复 initialize。

计划状态与计划动作的确定性冲突在 task.owner.candidate 写入前核验，并与 accept 复用同一校验函数。原生工具返回明确纠正反馈，在同一 turn 内修正；未合法提交前不封存候选，也不把此错误当成已接受的执行动作。最终接纳仍保留原版本、授权和计划状态守卫。实际业务恢复须保持同一 Task/session 和原失败审计，不借修复自动授权任何生产操作。

本次确定性 `TASK_OWNER_ADVANCE_CONFLICT` 已耗尽失败预算时，可经既有 retry-owner 入口恢复；精确CAS核验当前Owner/要求/控制版本，并要求最近一轮为released且无decision、无application。保留全部失败轮和原session，仅登记受管system.recovery事件。已接纳或已应用决定不能沿此入口重跑；恢复本身不更新来源材料或业务授权。
