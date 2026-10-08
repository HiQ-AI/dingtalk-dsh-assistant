# SG18 检查失败保留候选重入

根因：原 repairCurrentStage 经 changeInput→input.accept→applyPending 无条件生成完整节点计划，导致 prepare-generation、场景定义、工作区在新代重复。直接仅截取后缀仍会因代次工作区路径和 prepare-generation 固定输入造成错误。

本轮复用现有 repairAdmission 与 input.accept 事务。仅工程 verify-candidate 明确 ENGINEERING_VERIFICATION_FAILED、准备到修改前缀成功、后续均未执行且效果只有已确定 workspace/edit 时，保持同代、原需求引用、原工作区及实际候选，清空 inspect-and-propose 起后缀的执行输入/输出与会话，下一租约重新检查代码、校验提案、应用增量并真实验证。原始失效引用留在 workflow.repair.accepted 审计；事件仍用现有 repair context 查询。不直接 resume 旧失败候选。输入明确读取当前 Task 共享诊断和完整日志。

实跑 `node --test test/task-workflow-contracts.test.js`：23/23 PASS。新增真实 Controller/Store 用例核对准备4节点调用各1次、修改/验证后缀各2次；generation、requirementRef、前缀outputRef及lease不变。无 repair 身份直接送 candidateRepair 拒绝；已有成功 external 效果拒绝且不部分重置。现有未知效果/暂停/待输入/排空、通用整代修复反例继续通过。

边界：本轮仅检查失败的源码修复重入，本地业务验收失败与其他工作流仍原路径。未部署、未重放现场业务、未把失败检查伪装成功。正式检查日志配置修订由主代理另行受管处理。

## 追加：SG20 本地验收纯准备失败的配置 checkpoint

精确放行 prepare-local-acceptance/waiting/LOCAL_ACCEPTANCE_PLAN_INVALID，旧新定义均 code 且 pure/read、已排空、无输出、前缀全成功、后续未执行。沿原 run.workflow.checkpoint 维护与Task/Run/需求/来源CAS及零本地effects条件；不新增接口。事务保存原inputRef/inputDigest/lease/waitReason，Controller审计工件保留原失败evidenceRefs，再清理该纯准备失败。define/plan按新配置重评，工作区/修改/构建已成功输出不动，同Run同generation。

实跑：`node --test --test-name-pattern='本地验收checkpoint' test/execution-controller.test.js` 11/11 PASS；覆盖原verified/verify-waiting、scope/maintenance/revision漂移、规划超时/参数纠错、非精确错误拒绝、真实prepare失败恢复、已存在本地succeeded effect拒绝且状态不变、原失败审计内容回读。`--test-name-pattern='检查checkpoint'` 1/1 PASS，保留checks路径。未执行现场桥或修改业务/control数据库。

私有桥prepare工具以installed worker `const localPrepareRetry`存在预检实际门禁版本；profile/store独占与Task/Run/req精确快照照旧。正式现场仍须第二部署后重新capture/check，不复用第一包snapshot。

## 追加：受控恢复全局仓库配置漂移
原配置器新增互斥restore-proposal，复用YAML属性编辑/锁/CAS/rename。独立隔离测试11/11 PASS，覆盖正常check/apply、篡改、其他字段/未知仓库/旧checks任意降级、activeRun代次漂移。真实旧profile203…+当前0c94…零写check，计划恢复后3b5c562d4fea4ed95581698a90dbea4289d2b839dceb2c4dc68bbdbe34e628f6，3个activeRun repositoryDigest匹配。既有双向依赖/query/其他字段不变，未live apply。实际受控提案docs/tmp/five-repository-restore-bound-proposal.json。
