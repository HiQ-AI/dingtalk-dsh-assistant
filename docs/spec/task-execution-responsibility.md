# 任务执行责任与自动续行

日期：2026-10-13；开工基线：origin/main f37917d。

## 目标与现状

任务执行会话是任务唯一责任人，编排提供可靠执行能力。复用持久 Task Owner 作为任务级执行会话；节点会话是受托执行者，原节点错误回原会话处理，不另设监督者、不把责任转交流程。

当前 Owner 禁止 repairCurrentStage/workflowRevision，但 execution-recovery-policy 仍把业务验收失败交 task-owner 修复、阻塞交它重排。workflow-service 的恢复扫描只派发特定纠正和暂态重试；通用 inspectNodeRecovery/resumeNode 已有身份、来源、效果、成功前缀和重复问题保护，却缺少自动接线。既有测试手动调用 resumeNode，不能证明扫描闭环。

## 取舍

1. 只改提示词：无法补齐故障回送，排除。
2. 复用既有原会话续行事务：采用，补上自动派发、完整诊断、责任一致和无进展状态；保留冻结图、节点及效果身份。
3. 合并全部节点/去除流程控制：丢失权限与副作用边界，排除。

## 实施

- 统一任务 Owner、受托节点会话与 Host 的职责说明；失败分类中的执行修复责任归原执行会话，维护与审批仍显式分开。
- Controller 在正式 recover 路径使用 inspectNodeRecovery 接纳的通用原 Agent 续行，持久记录绑定当前 Task/Run/节点/需求/计划/控制版本的诊断上下文，复用 resumeAgent/node.resume，不新建状态机。
- 后台扫描对接纳的原 Agent 故障调用正式 recover；先处理原有 provider 重分类和专用工程纠正，不能把未知 provider、工程写入或外部效果重放当纯读取续行。
- 保留同 problemKey 重复无进展的持久拒绝，观察者能看到原节点身份和原因；不声称任意 code 失败都具备自动修复能力。没有受信修复能力的工程/代码失败保持可见等待，由任务执行会话如实跟踪，维护权限不隐含扩大。
- 修订当前 README/建设手册和运维说明，不重写历史 spec，不变更冻结 Workflow digest、数据库 schema 或历史任务。

## 验证

使用隔离 SQLite 与真实 Controller/Service 恢复入口证明自动回送，核对同 sessionId/nodeRunId/generation/inputDigest、成功节点仅运行一次、完整失败工件可读、重复扫描不重跑。覆盖重启、重复问题不空转、暂停/取消、需求过期、来源变化、未知效果及不可修正错误。原生会话提示与 Owner 拒绝修复的现有测试回归。定向测试通过后创建 PR，不擅自部署或恢复真实任务。

新增本方案与独立 acceptance 桶是因为这是新的跨层责任闭环任务，旧 SG20/历史方案不能作为本轮状态和验收。
