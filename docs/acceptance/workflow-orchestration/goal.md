# 流程编排与节点契约实施

> 状态：ACTIVE
> Goal ID：workflow-orchestration
> 最近维护：2026-09-22T14:14:15.1630866+08:00
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
| SG2 | 结构化计划、证据和 v9 | 引用与历史边界、迁移、消费端测试通过 | 进行中 | 纯模块已测，待集成 |
| SG3 | 可靠中转、重试、取消 | 故障恢复不重复动作且未知结果阻塞 | 待实施 | 待验证 |
| SG4 | 确定性检查与材料预检 | 注册检查器、材料完整性和版本校验通过 | 待实施 | 待验证 |
| SG5 | 执行许可与调度 | 不超并发、无旁路恢复、公平性反例通过 | 待实施 | 待验证 |
| SG6 | 综合验收与交付 | 基线对比、矩阵、PR 回读完成 | 待实施 | 待验证 |

## 当前检查点

- 当前子目标：SG2
- 唯一下一步：接入结构化计划和 v9 迁移，保留历史只读边界。
- 未闭环项：全部实现和新验收待完成；用户明确本轮仅本地验证与 PR；真实渠道 E2E 和真实迁移不执行。

## 进展

- 2026-09-22：确认 origin/main=83fc504，创建 worktree-workflow-orchestration，复制已批准方案。

## 重大决策

- 按方案的存储/调度依赖顺序集成；独立纯模块可并行准备，集成验证仍按批次执行。
- 第一批可独立交付；v9 变更作为共同候选验证，禁止真实存储试写中间格式。

## 重要信息

- 主仓 D:/project/dingtalk-dsh-assistant；隔离工作区 D:/project/dingtalk-dsh-workflow-orchestration。
- 基线版本 0.5.15；Node >=24；pnpm workspace。
