# 常驻与叶子协调修复

> 状态：ACTIVE
> Goal ID：resident-leaf-coordination-repair-20260910
> 最近维护：2026-09-10T09:15:54.924Z
> 权威目标：D:/project/dingtalk-dsh-assistant-coordination-repair/docs/acceptance/resident-leaf-coordination-repair/goal.md

## 总目标

实施 docs/spec/resident-leaf-coordination-repair.md 的修复，闭合当前事实、审批、报告接纳、计划修订、上下文与请求恢复，降低问答与协调延迟，完成本地验证、PR 及本地部署回读。

## 完成条件

- 五批能力实现并通过确定性反例和真实 DSH 集成检查。
- 验证结果、性能测量及未验证边界记录于 matrix.csv 与 round-N.md；不得将计划指标写成实测结果。
- PR、安装包和本地运行态独立回读；不发送测试消息到真实业务群、不重放生产动作。

## 范围与约束

- 工作树 D:/project/dingtalk-dsh-assistant-coordination-repair；分支 worktree-resident-leaf-coordination-repair，基线 origin/main b7d0ea1。
- 主仓保持原状；保留 #90 已合入的 checkpointReviewRuns。
- 复用 DSH 原生 Session/Inbox/LLM；仅修改本目标所需实现，不更新用户记忆。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | 共享事实/审批与活动投影 | 当前快照、500条滚动、乱序/幂等测试通过 | 已实现 | store/task-progress 及全套回归通过 |
| SG2 | 报告接纳/等待/计划与 Schema | pending 不重提、修订不误清空、诊断可达、阶段一致 | 已实现 | Runtime/报告/原生 Goal 反例通过 |
| SG3 | 内容复用与请求恢复 | 相同原文不重复读取、稳定重试、压缩/重启正确 | 已实现 | 原生 Session 复用与请求恢复反例通过 |
| SG4 | 短响应与发布前置 | 只读问答路径、遥测、批处理与前置流程可验证 | 已实现 | 同模型 30 次测量与流程版本回读完成 |
| SG5 | 集成/交付/部署 | 全套测试、反例、PR与安装运行态回读 | 进行中 | 全套 391/391 通过；独立审阅修复完成，PR #91 与 CI 通过，待部署 |

## 当前检查点

- 当前子目标：SG5
- 唯一下一步：等待业务任务结束或用户明确允许中断后，按 runbook 安装已核验包并回读。
- 未闭环项：本地部署；切换选择待用户答复，真实业务 E2E 保留 UNKNOWN。

## 进展

- 2026-09-10：#90 已 MERGED，fetch 后创建独立工作树；复制已审阅方案。

## 重大决策

- 根据用户 AGENTS.md 的复杂任务规则启用子代理，按文件职责隔离，主代理负责 Runtime 协议与集成。
- 部署需要待本地验证完成后再执行；现有运行数据不做就地试验。

## 重要信息

- 今天的原始审计保留于主仓 docs/tmp/session-audit-20260910，只提炼脱敏合成证据入库。
- 已部署 runtime.js 与 #90 的 297e9b7 一致。

- 2026-09-10 实施：新增报告通知持久状态与 pre-step 门禁，真实 DSH Loop 停等/恢复反例通过；全套测试由基线 309 项增加至 391 项，当前全绿。
- 部署前观察：当前有 2 个业务 Task running；切换前需核验实际执行状态，不能用测试通过替代维护窗口判断。


- 2026-09-10 交付：PR #91 OPEN；源码 0abe712；CI 34461854317 success；Assistant 包与摘要已独立核验。两个业务任务仍在运行，切换选择已提出，未终止进程、未安装候选。

