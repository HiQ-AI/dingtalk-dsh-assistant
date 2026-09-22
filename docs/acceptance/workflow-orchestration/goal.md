# 流程编排与节点契约实施

> 状态：COMPLETE
> Goal ID：workflow-orchestration
> 最近维护：2026-09-22T15:28:59.3972140+08:00
> 权威目标：D:/project/dingtalk-dsh-workflow-orchestration/docs/acceptance/workflow-orchestration/goal.md

## 总目标

实施 docs/spec/workflow-orchestration-contracts.md 的六批方案，使节点契约、结构化证据、恢复中转和调度形成可验证的闭环。

## 完成条件

- 六批实现与针对性测试通过，原生生命周期和存储恢复有独立证据。
- 迁移工具只写独立目标，检查模式零副作用。
- 文档及消费端同步，创建可审阅 PR 并独立回查。
- 真实渠道和生产迁移需独立授权及环境验证，未执行不得算通过。

## 范围与约束

- 仅修改本隔离 worktree；保留主仓未跟踪文件。
- 中文文档；复用既有 Host/Task/Outbox，不新增通用引擎。
- 真实 profile、生产数据及对外消息不作为本地测试目标。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | 契约和错误分类 | 原生工具 schema、回执语义和异常反例通过 | 已完成 | round-2.md，255/255 |
| SG2 | 结构化计划、证据和 v9 | 引用与历史边界、迁移、消费端测试通过 | 已完成 | round-11.md，596/596 |
| SG3 | 可靠中转、重试、取消 | 故障恢复不重复动作且未知结果阻塞 | 已完成 | round-11.md，未知结果与取消反例 |
| SG4 | 确定性检查与材料预检 | 注册检查器、材料完整性和版本校验通过 | 已完成 | round-11.md，材料与检查器集成 |
| SG5 | 执行许可与调度 | 不超并发、无旁路恢复、公平性反例通过 | 已完成 | round-4.md、round-11.md |
| SG6 | 综合验收与交付 | 基线对比、矩阵、PR 回读完成 | 已完成 | round-11.md、round-12.md、PR #116 OPEN已回读 |

## 当前检查点

- 当前子目标：SG6
- 唯一下一步：本轮本地验证与PR交付已完成，等待审阅；没有自动合并或部署步骤。
- 未闭环项：本轮范围内无。真实渠道E01、生产迁移及部署明确未执行，需要后续独立安排。

## 进展

- 2026-09-22：确认 origin/main=83fc504，创建 worktree-workflow-orchestration，复制已批准方案。

## 重大决策

- 按方案的存储/调度依赖顺序集成；独立纯模块可并行准备，集成验证仍按批次执行。
- 第一批可独立交付；v9 变更作为共同候选验证，禁止真实存储试写中间格式。

## 重要信息

- 主仓 D:/project/dingtalk-dsh-assistant；隔离工作区 D:/project/dingtalk-dsh-workflow-orchestration。
- 基线版本 0.5.15；Node >=24；pnpm workspace。

## 交付回读

- PR：https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/116，OPEN，base=main。
- 代码提交：8cc9df6194a24fa151c347dd0b329bbe82b02693；git ls-remote 与本地 HEAD 一致。
- 本地596/596、隔离原生DSH、UI10项、18次队列回放、三个包构建通过。PR创建时statusCheckRollup为空，不当作远程CI通过。
