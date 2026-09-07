# 常驻会话、Topic 与叶子 Task 协作改造

> 状态：COMPLETE
> Goal ID：resident-topic-leaf-audit
> 最近维护：2026-09-07T17:00:00+08:00
> 权威目标：D:/project/dingtalk-dsh-assistant/docs/acceptance/resident-topic-leaf-audit/goal.md

## 总目标

实施常驻会话、Topic 与叶子 Task 当前实现审计中确认的正确性、权限、恢复、调度、状态投影和上下文负担改进，并以隔离回归、全量测试和文档同步证明行为闭环。

## 完成条件

- 审计 F1–F9 的确定性缺口均已修复或以当前 DSH 能力证明边界并采用可验证的最小硬门禁。
- checkpoint 审阅、Task 输入、审批、取消与 Topic decision 的崩溃/重试窗口有幂等回归。
- waiting 不阻塞独立可执行 Task，取消信号不等待无关 Session 生命周期操作。
- Resident/叶子提示词去重并对动态 Task、Topic、消息输入实施总量边界，不丢失固定版本回读能力。
- README、设计说明和看板状态语义与代码一致。
- 本轮新增矩阵全绿，`pnpm test`、必要构建/打包与 `git diff --check` 通过。

## 范围与约束

- 保留每群一个 Resident、持久 Topic、每 Task 一个叶子 Session + Goal 的主体结构，不新增 Topic Agent。
- 不迁移或重放真实群消息，不连接 DWS，不部署本机 profile；真实业务 E2E 单独列为未验证边界。
- 只修改本目标相关源码和文档；开始时已有未跟踪 `docs/tmp/`，不得改动或纳入提交。
- 复杂状态改造先以真实 Store/Runtime 隔离用例证明，再修改实现；现有正常路径不得退化。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | 正确性与授权边界 | F1–F5 有硬门禁、持久恢复或短临界区实现及反例测试 | 完成 | round-2.md A01/A03/A04/A06/A07/A09 |
| SG2 | 状态与调度一致性 | F6、F8、F9 修复且 Observer/API 语义一致 | 完成 | round-2.md A02/A09/A10 |
| SG3 | 减少无效重规划和 Resident 往返 | F7 与 checkpoint 审阅策略改造，保留版本正确性 | 完成 | round-2.md A03/A05 |
| SG4 | 提示词和动态上下文预算 | 固定提示去重，Task/Topic/消息 envelope 有总预算和分页入口 | 完成 | round-2.md A08 |
| SG5 | 全量交付验证 | matrix 全绿，全量测试、构建/打包、diff 检查和文档一致性通过 | 完成 | report.md |

## 当前检查点

- 当前子目标：SG5
- 唯一下一步：无；进入提交和 PR 状态回查。
- 未闭环项：真实 DWS E2E、本机 profile 部署与网络工具级隔离不属于本轮验证范围。

## 进展

- 2026-09-07：完成当前实现审计；既有测试 236/236 PASS，10 个隔离探针成功复现或量化 F1–F9 及上下文体积。该 PASS 不代表缺陷已修复。
- 2026-09-07：用户明确要求实施，建立本目标文件并进入 SG1。
- 2026-09-07：A01–A10 修复探针全绿，既有测试 236/236 通过，三个发行包打包成功；SG1–SG5 完成。

## 重大决策

- 保留 Resident/Topic/Task 三方结构；先修 Host/Store 的确定性门禁与恢复，再减少提示词和模型往返。
- 不以提示词删减替代权限边界，不以固定字符截断替代可分页的固定版本读取。

## 重要信息

- 源码起点：本地 main `9cf0687c69ff2332a0e778b8b72f59c1131d4bde`，package version `0.5.13`；未 fetch，不能据此声称远端最新。
- 审计方案：docs/spec/resident-topic-leaf-audit.md。
- 隔离探针：docs/acceptance/resident-topic-leaf-audit/scripts/probe.mjs。
