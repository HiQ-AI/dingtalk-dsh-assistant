# 原生子会话日志绑定修复

## 目标及现状

原任务 task-c74a355e5506fd9b2ed6af998a14263d 的 UAT2 执行已成功，但原生 subagent 创建日志时触发 TASK_SESSION_BINDING_REQUIRED。现有路由仅由任务/执行入口预登记，DSH 原生子会话经 agents.create 新建，不经过这些入口。原失败调用按 unknown 保存，自动对账不能证明效果，因而阻止完成。现场已通过正式 operator reply/check（writes=0，原结果1229，正常结束1611，绑定调查1项）及 reply 结算 failed/partialEffectsPossible，原任务已正常 complete；未重放部署。

## 方案和边界

复用 task-session-persistence 安装与卸载流程，包裹原生 Agent registry 的 create/resume。仅在 parentAgent 是 registry 中同一真实存活对象且父会话已有任务路由时处理；校验 child origin、parentSession 与 cwd，再预登记同任务路由并在 runOwned 内调用原生 factory。恢复读取原生日志 header 核验同一父链，禁止借父身份恢复别的任务或根会话。普通会话继续原生路径，直接 persistence 写入仍要求精确 Host writer。无 schema 变更，不根据错误字符串自动判无效果。

## 验证及交付

定向原生测试覆盖创建、实际模型回合/进程 cwd、恢复、嵌套子会话、伪父对象、错误父链、跨任务、直接日志写入以及卸载还原。先复现后修复，运行现有 persistence 和任务/执行关联回归。独立回读任务完成、原操作保留历史及 PR 状态。根因修复按 PR 交付，部署另按静止实例 runbook 核验。
