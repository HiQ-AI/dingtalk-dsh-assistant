# Task 修订决策阻塞根因修复

> 状态：ACTIVE
> Goal ID：task-decision-validation-20260911
> 最近维护：2026-09-11T13:44:00+08:00
> 权威目标：D:/project/dingtalk-dsh-assistant/docs/acceptance/task-decision-validation/goal.md

## 总目标

修复任务协调与通知的永久阻塞因果链，恢复当前本地现场，并验证不重复执行、不绕过审阅、不丢输入。新增范围为 Outbox 替换链：消息发送、替换关系与撤回分别记录，不使撤回失败阻塞纠正通知。

## 完成条件

- 稳定阶段身份、原子接纳校验、持久坏决策重新判断均通过反例测试。
- 全量回归与独立审查完成，代码交付 PR 且本地安装文件可追溯。
- 现场坏决策停止重试，原消息与报告正确收口，叶子产生后续实际执行事件。

## 范围与约束

- 当前 feature/task-decision-validation 基于 origin/main e961e51。
- 不用标题兼容或猜测阶段 ID；不手改生产 Store；不实施叶子负责的业务改动。
- 沿用 web profile 配置和 DSH 版本；不更新用户记忆。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | 契约与状态修复 | 确定性输入错误提交前拒绝，持久错误可审计退回 | 完成 | docs/spec/task-decision-validation.md |
| SG2 | 反向验证 | 重启/并发/部分执行/正常路径通过 | 完成 | matrix.csv |
| SG3 | 交付和现场 | PR/包/服务/业务续跑分层回读 | 完成 | round-1.md |
| SG4 | 回复替换状态机 | 未发送与发送未知不混淆，替换与发送串行，纠正送达后独立撤回 | 完成 | ../../spec/outbox-replacement-lifecycle.md |
| SG5 | 替换回归与现场 | 并发/崩溃/链式替换通过，原纠正实际送达，错误重试停止 | 进行中 | round-2.md |

## 当前检查点

- 当前子目标：SG5
- 唯一下一步：按 runbook 部署两个固定包并回读原纠正通知。
- 未闭环项：再次部署和纠正通知回读。

## 进展

- 2026-09-11：全量 405/405 测试、客户端构建通过；独立审查最后一轮未发现明确阻断，现场部署待验证。
- 2026-09-11：PR #93 OPEN，本地固定包安装及认证首页验证通过；原 Topic 6/6、Task v5 确认、计划经审阅 accepted；同一叶子实际执行 git fetch/worktree 命令成功，现场恢复完成。
- 2026-09-11：已确认 runSequence 3、inputVersion 4，plan 报告 input-wait，Topic revision 6/processed 4；坏决策引用不存在 stageId。

## 重大决策

- 删除上轮标题兼容；所有 ID 由代码提供，错误输入交模型纠正。
- 仅所有 Task 动作未执行时允许拒绝旧意图；保留历史与渠道回执，不能把拒绝当完成。

## 重要信息

- 实际存储 root 为 C:/Users/64554/.dsh/storages/dingtalk-dsh-assistant-v7-20260907；备份在仓库外。
