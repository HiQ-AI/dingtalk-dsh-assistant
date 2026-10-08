# SG18 检查失败保留候选重入

根因：原 repairCurrentStage 经 changeInput→input.accept→applyPending 无条件生成完整节点计划，导致 prepare-generation、场景定义、工作区在新代重复。直接仅截取后缀仍会因代次工作区路径和 prepare-generation 固定输入造成错误。

本轮复用现有 repairAdmission 与 input.accept 事务。仅工程 verify-candidate 明确 ENGINEERING_VERIFICATION_FAILED、准备到修改前缀成功、后续均未执行且效果只有已确定 workspace/edit 时，保持同代、原需求引用、原工作区及实际候选，清空 inspect-and-propose 起后缀的执行输入/输出与会话，下一租约重新检查代码、校验提案、应用增量并真实验证。原始失效引用留在 workflow.repair.accepted 审计；事件仍用现有 repair context 查询。不直接 resume 旧失败候选。输入明确读取当前 Task 共享诊断和完整日志。

实跑 `node --test test/task-workflow-contracts.test.js`：23/23 PASS。新增真实 Controller/Store 用例核对准备4节点调用各1次、修改/验证后缀各2次；generation、requirementRef、前缀outputRef及lease不变。无 repair 身份直接送 candidateRepair 拒绝；已有成功 external 效果拒绝且不部分重置。现有未知效果/暂停/待输入/排空、通用整代修复反例继续通过。

边界：本轮仅检查失败的源码修复重入，本地业务验收失败与其他工作流仍原路径。未部署、未重放现场业务、未把失败检查伪装成功。正式检查日志配置修订由主代理另行受管处理。
