# Bytebase建单与插件人工审批流程

2026-10-02用户明确：人工审批指插件审批，不是Bytebase平台原生审批。此前将SKIPPED作为平台配置异常并分派管理员的方案已撤回，相关在途代码未部署。真正根因是从getIssueApproval工具存在推断审批来源，混淆工单执行平台与批准渠道。

修复现有流程：准确候选与必要只读基线→创建并独立回读Bytebase工单→插件审批请求绑定Issue/Plan/Sheet/SQL/目标/包→真人批准执行→独立回读；驳回修改后以新版本重新送审。简单加列不引入全库调查或UAT前置。Bytebase SKIPPED不是插件审批状态，不再要求修改平台规则。

当前工单857保留；受管接续复用原Task、成功调查和工单证据，不重复建单，不直接改线上SQLite。插件审批前零生产执行，批准不得沿用到不同SQL，未知写入仍先对账。执行会话负责诊断并处理实际可解决的问题；只有真实缺权限或业务决定才等待。群通知简短：工单已新建，等待人工审批；完整条件留详情。

## 冻结 v5 的受管交接

旧 Run 的原生审批 gate 已进入 unknown，不能直接取消、改定义或伪造批准。先用现有 context 入口纠正当前验收和明确授权来源为插件审批；新的交接入口提供 dryRun，只读核验当前 Task/Run、版本、租约、排空、维护和来源。apply 再核对唯一旧 gate、准确 SQL/包/Issue/Plan/Sheet/目标、SKIPPED、Task NOT_STARTED 且无 TaskRun，才通过原生 effect.observe 将这次纯审批观察以“审批渠道已替换”失败终态收口。原生 stop 收口旧 Run，Owner 在同 Task revise 第四阶段，前三成功前缀保留。

Controller 不支持从中间节点启动 Run，也不支持跳过候选 agent 节点。因此增加领域接续定义 task-data-change-approval-resume：一个受信只读冻结已有工单节点，随后直接复用 v6 的插件审批到执行回读节点。仍使用同一 Controller 和效果账，不增加调度器。输入从 Host 读取旧 Run 的持久交接工件，不接受模型任意 issueRef；每次再次核验已有工单未执行、包和生产精确表基线。只切换批准渠道，既有 SQL/工单/包保持准确绑定。

交接按 requestId 和当前需求版本幂等；并发修订、未排空、未知写效果、非 SKIPPED 或已有 TaskRun 一律拒绝。dryRun 可报告验收尚待纠正，但 apply 必须由当前同 Task 最新来源明确授权插件审批。部署后独立验证冻结 v5 可恢复、旧 unknown 终态关闭、旧 Run 取消及新插件审批请求出现，审批前所有生产发送保持为零。

## 旧 Host 尚无接续入口时的受控部署

旧原生待审 unknown 会阻止正式维护 seal，不能先安装再对账。复用现有离线部署顺序：维护禁派发、配置 CAS 与完整退出见证、owner 锁、停精确旧 PID、完整备份；随后运行 `scripts/reconcile-data-change-approval.mjs --manifest <绝对路径> --reconcile`。清单显式绑定路径、配置摘要、完整业务/Run/节点/输入/Owner 摘要、备份摘要和维护身份，不包含写平台权限。`--check` 和 `--readback` 均为零写。

对账仅提供 Bytebase 工单/审批/TaskExecution GET 和生产只读基线/前置核对；复用已冻结 v5 校验及现有 Delivery 的只读审批失败收口，不调用 Controller 调度、stop、需求修订或 Owner。唯一审批观察关闭后原生 seal，再按部署框架安装和启动新 Host，由正式 handoff 完成同 Task 接续。若观察已关闭但 seal 前中断，重放核验完整旧备份和原文件，允许此次受信观察新增工件；不重复发送或修改工单。
