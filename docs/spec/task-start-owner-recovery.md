# 任务启动通知与执行纠错

## 授权合同根因与方案

当前新建生产 Editor is_deleted 任务的原生 Owner 会话只读查询已成功，seq441、753 的候选被阶段授权拒绝后 seq1106 转 block。不是查询权限缺失。入站 stageAuthorizations 的 objective/gate 可选，Host 准入却要求二者完整；workflowId 简写还会生成不完整授权。候选 sourceCondition.objective 被写成包含 SQL 的实现描述，违反逐字原文范围合同，通用反馈未标明字段。

方案：外部阶段授权从入站模型 schema 到落账都要求 workflowId/sourceQuote/objective/gate，objective 必须是 quote 连续原文；外部 workflowId 简写不能代替完整阶段授权。非外部目录仍保留既有字段选择。Owner 从已落账授权逐字复制 sourceCondition 和 gate，实现候选及 SQL 留在执行参数和 summary。Host 对原文范围、完整性和确认门槛的拒绝返回具体原因，允许同会话纠正，不降低授权验证。

本次旧 Task 缺失字段沿现有 POST /tasks/:id/repair-stage-authorizations 恢复：先只读核验当前 requirementRef/revision、source actor/body/version、无阶段/Run/外部效果且 Owner 已排空；Web 身份只修复同一既有 workflowId，原文完整 quote/objective，gate none（表示不另加任务前置确认，绝非插件执行批准）。修复事务 CAS 并写 authorization.projection.repaired，保留原 Task 和失败，再由 Owner 重评，不改 SQLite。插件本次精确 SQL 真人批准仍独立必需。

反例：缺字段入站不能落成不可执行 Task；改写 objective、跨来源、过期来源必须拒绝；用户原文要求先验证再正式执行时 gate confirmation 与真实 actor 不可删除；none 不代表插件批准，旧工单批准不能重用；工具拒绝需说明实际不匹配字段，不能让模型盲猜。

## 开始通知及验证方案

当前静默策略把任务开始一并抑制。修改为真实任务接纳后通知一次，而普通调查/执行/验收进度、内部失败和恢复过程继续静默。新通知以逻辑 Task 身份绑定原生持久事件键，不取阶段 Run；重复 create、补充、重评与重启保持同一通知，未知发送只独立回读。准备及领取均核对真实已应用命令、来源、当前 Task 控制及终态，完成/取消的旧任务不补发；Web和原文明确不回复维持静默。

针对实际失败路径验证完整阶段授权、改写原文纠错、生产插件审批未替代、开始通知唯一、零Run接纳、取消/完成/未知发送/静默反例。通过后按原生维护排空、封存及精确包安装，独立回读新进程与健康，再用现有受管授权修复接口恢复原 Task；不代批准或直接执行生产 SQL。实际群通知仅由修复后原流程发送，手工不补第二条。

## 第二根因：调查事实在SQL候选边界丢失，候选不能受管纠正

第一次授权修复后r2 Owner已合法创建数据变更阶段，但freeze-input只带原群原文和数据库目标，propose-sql没有Owner确认的public结构，输出空applySql/verificationSql并说schema不确定。Host validate-package因此DATA_CHANGE_PROPOSAL_INVALID。当前分类将候选错误当maintainer implementation-error；通用恢复只支持agent纯读节点，不支持code校验节点回到前序候选，数据变更无领域修复合同。

实施：外部data-change阶段prepare携带当前Task/revision/scope及原生查询引用，平台prepare独立查原生query-evidence账、工件绑定和输出digest，转为既有sources供候选节点读取，不新增工作流节点、不修改冻结v7。当前需求没有query证据时提交前具体反馈让同Owner查询；repair候选同样提交前校验，不能先accept再apply失败。

无外部效果的当前validate-package候选非法由显式领域恢复策略接回同Run，重新准备当前权威原文、目标与查询sources，附真实诊断，用原生changeInput/new generation重新生成候选；effects存在、未知执行或已建工单时拒绝该恢复。另行保留本次插件批准，不能重建已有工单。旧r1证据不可装成r2证据；本轮应由Owner只读重查。

## 实际任务关联场景：整型常量默认值

实际正确SQL已生成，失败进一步收敛为简单加列只认无默认值。补可空smallint/integer/bigint整数字面量默认值，范围和SQL语法严格核验，函数/表达式/NOT NULL仍不走简单路径；数据库期望默认表达式保持原值验证。

原失败校验不是新的用户条件：仅准确的旧前置校验失败、全部排空且无任何效果时，Host使用当前Run冻结只读校验实现核对原候选；现在仍失败不可恢复，现在真实通过才提供受管恢复。成功验证的静态事实交给当前候选输入，保留旧失败并原Run新generation重新校验，插件审批独立且不代批准。沿现有领域修复票据，不新增通用code重试协议。
