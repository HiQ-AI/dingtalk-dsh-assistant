# 任务执行责任与自动续行

> 状态：ACTIVE
> Goal ID：task-execution-responsibility
> 最近维护：2026-10-13T09:30:00+08:00
> 权威目标：D:/codex/worktrees/task-execution-responsibility/dingtalk-dsh-assistant/docs/acceptance/task-execution-responsibility/goal.md

## 总目标

以持久任务执行会话为唯一任务负责人，编排服务于执行；可修正节点故障自动回到原会话，保留成功工作和授权边界。

## 完成条件

- 通用原会话恢复经真实 Service/Controller 路径验证，不依赖测试手动 resumeNode。
- 责任分类、会话指导、恢复观察和文档一致；不具备修复能力时如实报告。
- 成功前缀、原身份、效果对账及无进展保护通过定向反例；提交并独立回读 PR。

## 范围与约束

- 主检出已有未提交工作保持不动，开发在 worktree-task-execution-responsibility。
- 不改冻结流程、schema，不部署、不唤醒真实业务任务；不开放 Owner 修复或模型改图。
- 本轮仅新建方案及验收桶；源码和测试优先扩展现有文件。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | 实现原会话自动续行与诊断 | 真实控制链路同身份续行，保留前缀 | 已完成 | round-1-service.log：13/13 |
| SG2 | 统一责任合同和会话指导 | 分类与提示无越权修复要求 | 已完成 | round-2/contract-tests.log：286/286；round-4/classification-tests.log：10/10 |
| SG3 | 独立反例验证与文档 | matrix 全绿且审查问题关闭 | 已完成 | report.md；最终恢复36/36、Service23/23 |
| SG4 | 提交与 PR 回读 | 本地实跑、远端状态及正文一致 | 进行中 | 准备提交 |

## 当前检查点

- 当前子目标：SG4
- 唯一下一步：检查最终 diff，提交并创建 PR，独立回读远端状态。
- 未闭环项：提交与 PR；部署和真实任务不在本次范围内。

## 进展

- 2026-10-13：已读现实现及既有恢复测试；基线复核确认手动续行与自动扫描之间缺接线。隔离 worktree 已核对 HEAD 和干净状态，开始准备依赖。
- 2026-10-13：通用续行接通；新增测试暴露 failed Run 被列表及终态过滤排除，已以显式 includeFailed 补齐当前活动任务扫描。审查发现通用节点无工件工具，改为随恢复上下文交付完整白名单证据。Service 13/13 通过，首批旧 Owner/扫描24/24通过；完整回归继续。
- 2026-10-13：完整回归286/286、Service23/23、恢复36/36通过；分类同因收口后10/10及36/36复跑通过。修复底层无进展重领旁路；两轮独立审查阻断已关闭。验收已完成，进入 PR 交付。

## 重大决策

- 复用当前持久 Owner 为唯一任务负责人，节点会话为受托执行者；Host 的证据门禁不是第二个业务责任人。
- 自动续行仅走已有安全准入，不通过增加错误白名单或重建 Run 强行恢复 code/外部写入失败。

## 重要信息

- 起点 f37917d；开发目录 D:/codex/worktrees/task-execution-responsibility/dingtalk-dsh-assistant。
- 详细用例状态以 matrix.csv 为准；每轮输出进 round-N.md。
