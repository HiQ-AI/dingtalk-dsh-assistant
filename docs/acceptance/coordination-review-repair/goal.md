# 协调层审查修复

> 状态：COMPLETE
> Goal ID：coordination-review-repair-20261022
> 最近维护：2026-10-22T12:13:56.9524800+08:00
> 权威目标：goal.md

## 总目标

修复两轮审查的 R1–R4、F1–F3，以及相关 Windows 验证和 README 遗漏；本地实跑回归、提交并创建可审阅 PR。

## 完成条件

- 七项问题有正式回归及通过证据，相关兼容/失败路径通过。
- Windows 原失败用例运行到实际恢复断言。
- 文档与实现一致，提交与 PR 独立回读。
- 不部署、不触发 CI、不操作真实群或业务数据。

## 范围与约束

保留主工作区已有改动。固定基线 3d7a188，复用 coordination-review worktree，分支 worktree-coordination-review-fixes。相关测试使用仓库锁定 native profile。证据分别记录代码、测试和 PR；不声称生产验收。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | R2/R3 指令生命周期 | 澄清可收束、局部取消不阻断原任务且保留其他约束 | 完成 | round-1/ledger-tests.log、ledger-scope-tests.log |
| SG2 | R1/F1 计划与前置组合 | future 修改和时间/观察前置两种顺序均正确 | 完成 | round-1/schedules-boundary.log、schedules-native-final.log |
| SG3 | R4 公平恢复及 Windows 验证 | 后续可运行项推进，强退恢复断言执行 | 完成 | round-1/fairness-migration.log，含依赖等待分支 |
| SG4 | F2/F3 查询与异常通知 | 异常原因可见、过期通知可恢复且不重复 | 完成 | round-3/unit-tests.log：307项；native-tests.log：42项全绿 |
| SG5 | 集成验证与交付 | 文档、matrix、相关测试、PR 状态回读 | 完成 | README/runbook已同步；最终364项通过、0失败0跳过；PR #244 OPEN，base main，head worktree-coordination-review-fixes，gh独立回读 |

## 当前检查点

- 当前子目标：SG5
- 唯一下一步：无；修复已交付 PR #244，等待代码审阅。
- 未闭环项：本轮无；合并和现场部署不在范围。

## 进展

- 第 1 轮：建立唯一目标与子目标，开始实现；用例轮次另记 matrix.csv。
- 第 1 轮实现：R1–R4/F1 正式回归通过；交叉审查补齐正常返回 waiting 不占预算、取消前dispatch后claim，以及过期摘要许可前回读取消事实。
- F2/F3：单元与服务37项通过；native 首轮夹具缺 canonical 毫秒时间，次轮夹具未先终结原任务导致普通恢复改变元数据，均保留日志并按真实合同修正，未削弱断言。

## 重大决策

- 按项目大型任务约定并行分工；共享 checkout，不交叉修改同一职责范围，不由子 Agent 提交。
- F1 必须支持原 A 观察与时间同时约束 B，不用修改 A 或拆成相互无关安排绕开。
- 新通知复用已有聚合、许可与 outbox，不引入第二套投递机制。

## 重要信息

历史审查证据保留在本地 ../task-coordination-v1.3/review-20261022.md，未纳入本 PR；自包含问题说明及最终证据见 report.md 和 matrix.csv。历史反例不能作为修复通过证据。

## 下一步与未闭环项

PR 已交付并独立回读：https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/244 （OPEN）。代码提交 2d69f76；本次收尾提交仅更新交付记录。真实模型/钉钉/现场部署不在本轮执行范围。
