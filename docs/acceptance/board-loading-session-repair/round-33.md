# 任务开始通知与授权纠错验证

## 已确认根因

新Task task-bb6e65299c19a47657ee54bc903919c0 无阶段/Run，Owner已应用block；数据库结构查询已成功。stageAuthorizations的入站schema允许遗漏objective/gate，Host准入却要求完整；Owner两次改写objective不符合sourceQuote原文。笼统TASK_OWNER_STAGE_NOT_AUTHORIZED反馈没有给出字段，导致错误调整后停住。群记录12:00到修复前完整窗口仅源需求一条，无开始通知。

## 本轮范围

恢复一次新任务接纳通知，其他中间进度仍静默；统一完整授权源头/执行合同和具体纠错反馈。保留真实来源、控制、插件真人审批、当前需求绑定与未知效果对账；旧Task沿现有授权投影修复API接续，不改在线数据库。当前实施及测试中，本记录尚不表示部署或业务完成。

## 第一轮安装及真实恢复

通知完整52/52、另新增原生负例1/1、服务通知7/7、内部故障静默4/4；原生Owner全25/25；授权实际路径6/6均通过。正例在同Owner先错误改写objective，收到具体反馈后立即修正，进入隔离工单/插件pending；生产execute适配器禁止。

正式包SHA256 70beaa2e7f92e4be638ae1819d9547906fdb56fcf2021f0c626198cf1d5020ce。Check writes0/tasks1；安装/Readback/Resume通过，新PID49020健康，维护解除revision420、dispatchResumed=true、自启Enabled=true、backupCreated=false。原Task经repair-stage-authorizations CAS保持身份、原来源及Owner，需求revision1→2，原阶段授权已应用，stage1已创建并运行。群12:20至回读时窗口complete=true，2条消息（需求和唯一开始通知），未手工补发。

实际恢复发现第二根因，未闭环：stage1 propose-sql已成功落账，但applySql/verificationSql为空；validate-package等待DATA_CHANGE_PROPOSAL_INVALID，Owner又block。冻结输入只包含群原文与平台目标，没有Task Owner核实结构证明，数据变更合同缺少候选无效果恢复能力。未建本次工单，未生产执行。下一轮解决证据交接及原生候选恢复；本轮测试/通知/部署PASS不能代替业务推进完成。
