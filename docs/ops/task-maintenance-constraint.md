# 工程维护范围说明

本地维护时，可使用正式 POST /tasks/:taskId/maintenance-constraint 向指定原 Owner 提交范围说明。字段为 requestId、text、expectedRequirementRevision、expectedControlRevision 和 evidenceRefs。接口只接受已有 Web 操作身份和正在生效的同任务 task-scoped 维护范围；阶段及原 Run 必须已成功。引用必须包含真实当前需求与阶段输出，可补充原节点的正式证据。

说明以 engineering-maintenance-constraint artifact 保存，明确 channel=internal-maintenance、操作 actor、原 task/Run/阶段、原始来源及真实证据。它复用 fact(constraint) 的 intent.received 事件，不冒充新钉钉消息，不更改需求来源或原回执。相同 requestId 重放返回原来源与事件；内容不同拒绝。Owner 仍须正常提交各验收项 assessment，经原完成校验与 manifest 收口。接口不直接完成、不合并、不部署，也不解除维护或唤醒其他任务。

新进程不得继承旧 task-scoped 许可。原工程 Run 和当前阶段均已成功时，可由明确的维护操作以 allowedEffects:["progress"] 为同任务、原 Run、当前需求及控制版本、原群重新绑定收口许可。该分支要求任务控制为 active，返回 completionOnly:true 和空 nodeIds；只允许原 Owner 的 claim/accept/applied。所有通知派发、节点执行、effects、消息协调器、控制变更和新阶段派发明确拒绝。progress 在此分支仅为既有请求枚举，不能作为群消息发送许可。原有进行中任务的 paused/running 准入及来源、业务完成门禁保持原样。

启动恢复须保留仍待 Owner 收口的成功工程 Run 的原 digest 定义及 completion contract。失败、取消、无 Owner、或 Owner 已正常 complete/applied/idle 的终态记录继续跳过；恢复定义不派发新节点，不改变来源与完成校验。
若定义恢复前 Owner 已释放 turn 并因内部错误 blocked，维修重试使用原始 expectedLastFailure 文本，不改历史故障名。新增准入仅适用于当前进程 completionOnly 范围的同 task/原成功 Run：当前需求/计划/控制版本一致、节点全成功且 drained、effects 全终态、存在未读事件、最后 turn released 且无候选/决定/应用。原生 retry 产生 system.recovery 事件，保留原事件及同一 Owner 会话；正常 assessment/manifest 才能完成。范围外未知错误仍拒绝，通知/节点/其它任务仍禁止。
当前 Owner 输入展开维修事实正文及来源，而非仅暴露 artifact 索引。规范 source 的 task/requirementRef/current stage+Run 保持一致；原 actor/channel/sourceRef、原始 sources 和证据原样进入 maintenanceConstraints。已消费事件仍从原事件及规范 artifact 读取，无需重发 constraint。说明不是新群消息/合并部署授权，也不能替代 assessment 或跳过原来源条件。
在 current-process completionOnly 范围，原 successful stage/Run 全节点 drained、effects 终态后，retry-owner 可使用真实 expectedLastFailure:null 对原已 accepted/applied 的 approval-wait 重新评估。要求最后 turn 的需求/计划/控制版本仍当前、Owner idle 且无 currentturn；正常未知错误/未应用候选/其它 task 与 scope 外重评继续拒绝。原 applied wait 和 processedwatermark不回滚，新 system.recovery 仅唤醒原 Owner；正常 completion policy/manifest 决定完成。

Owner 当前输入提供 completionEvidenceRefs（当前成功阶段的规范 output/evidence 与已验证查询证据）。complete 引用同一成功 Run、当前 generation 且已 drained 的成功子节点产物时，Host 根据实际节点绑定归一到规范阶段证据，再执行原 assessment、manifest 与业务语义验收；不改变验收项或 satisfied 状态。不存在、外任务/Run、失败/取消产物拒绝，不能由摘要或自由文本证明。schema/引用可纠正错误在同轮返回可用规范引用，至多三次补交；重复同一无效决定立即结束，避免无界循环。
已应用 execution-block 若所有证据绑定同一受限成功 Run，并实际引用其成功子节点而非仅规范阶段引用，可在既有 current-process completionOnly 范围内通过原 retry-owner 恢复一次。仍保留原会话、历史决定及 watermark；同 Run/requirement 的 bindingRecovery 记录限制再次恢复。不能唤起节点、通知或其他任务，不能跳过完成验收。

正式受理且绑定当前任务、需求和阶段的维护澄清同步进入独立领域交付审查及其缓存键。澄清用于解释原验收范围，补充观察仍需与真实执行事实核对；不改变验收项、权限或通过条件，不替代执行证据。
