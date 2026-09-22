# 流程编排与节点契约实施

> 状态：ACTIVE
> Goal ID：workflow-orchestration
> 最近维护：2026-09-22T17:45:00+08:00
> 权威目标：D:/project/dingtalk-dsh-coordination-latency/docs/acceptance/workflow-orchestration/goal.md

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
| SG7 | 群聊延迟与任务发起修复 | schema、字段反馈、公平调度及新输入保护回归通过，本地验证与 PR 回读 | 已完成 | round-16.md；613/613；PR #117 OPEN |
| SG8 | 修复包本地部署 | 精确安装摘要、新进程、健康、认证Web及延时存活回读 | 已完成 | round-17.md；源码60f883c；PID69760 |

| SG9 | 决策上下文与积压闭环 | 工具契约、轮转及慢提交针对性回归，部署及六项状态回读 | 恢复核验中 | round-18.md；623/623；PR #118 OPEN |

## 当前检查点

- 当前子目标：SG9
- 唯一下一步：407c59d已部署且API/桥接恢复；补修同稿checkpoint字段顺序误判，回归后前向部署，通过原报告retry恢复权限核查。翻译已重新决策并重开原Task，但原Session缺失，与另两条历史重开Task单列阻塞。不自动合并PR。
- 未闭环项：真实渠道 D03 未验收。原 #1336 话题已进入决策、尚无关联 Task；本轮不将其标为业务完成，也未人为补建。首次部署空转问题已前向修复，第二次实例健康稳定。

## 进展

- 2026-09-22 SG9：发现决策缺少流程目录、单步轮转放大等待、计量与业务共用整库写链、DWS文件卡片尾注误判。四项本地修复已实现，最终回归进行中。PR #117已合并804c56c，新分支codex/decision-context-backlog基于同树origin/main。
- 17:40旧包回读：#1336/#1353/#1354已有running Task，#1371已reopen queued；#1350旧决策blocked，#1372尚无Task。此为旧包推进事实，不归为SG9效果。运行中任务未结束前依runbook保留实例，不强制重启。

- 2026-09-22：确认 origin/main=83fc504，创建 worktree-workflow-orchestration，复制已批准方案。
- 2026-09-22：续修前确认 origin/main=ee4835c（PR #116 已合并），创建 codex/group-coordination-latency 隔离工作区；基于现场 #1336 证据追加 SG7。
- 2026-09-22：公开决策分支和字段反馈修复；原生 AgentLoop 公平推进与图文任务创建回放通过，前一话题未结束时已创建唯一 Task，协议 attempt 保持 0。缓存重提交完成协调账问题经审阅发现并回归修复。

## 重大决策

- 按方案的存储/调度依赖顺序集成；独立纯模块可并行准备，集成验证仍按批次执行。
- 第一批可独立交付；v9 变更作为共同候选验证，禁止真实存储试写中间格式。
- SG7 保留未知输入的原子提交保护，只解除准备门禁；路由等待草稿在内存重验，旧 Topic 版本失效。无法同时保证无限未归类输入下无等待和处理所有已入站撤销。
- SG7 补充叶子许可的输入门禁，防止 Decision 接纳后刚到达的撤销被任务启动越过；允许协调处理完成后重新排队。
- 2026-09-22 用户追加本地部署：读取当前 v9、无活动 Task，使用本轮精确修复包安装，停止前备份稳定存储及 profile。不会重跑历史迁移或批量补发。

## 重要信息

- 主仓 D:/project/dingtalk-dsh-assistant；当前隔离工作区 D:/project/dingtalk-dsh-coordination-latency。
- 基线版本 0.5.15；Node >=24；pnpm workspace。

## 交付回读

- 本轮 PR：https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/117，OPEN，main ← codex/group-coordination-latency，已独立回读并附加任务。
- 最终本地部署源码：60f883cfeae9020c7a9a78fac3a2274c371efb64，包摘要及备份/运行态见 round-17.md；后续提交仅补充验收文档。
- 全量613/613；安装34个JS摘要一致；17:20后仍health ok、入站/桥接正常、恢复错误0，双端口PID69760。

### 上一批交付历史

- PR：https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/116，OPEN，base=main。
- 代码提交：8cc9df6194a24fa151c347dd0b329bbe82b02693；git ls-remote 与本地 HEAD 一致。
- 本地596/596、隔离原生DSH、UI10项、18次队列回放、三个包构建通过。PR创建时statusCheckRollup为空，不当作远程CI通过。

### SG9交付

- PR #118 OPEN，代码63a157f7a2dca9b8a5ae0818ba7eb7e2d8dac939；最终623/623通过；本地tgz209851字节，SHA256见round-18.md。
- 当前包仍是60f883c；新包未安装。已完成源码、测试、打包和PR，部署与真实业务恢复仍未闭环。用户尚未回答切换风险选择前不停止现有实例。

- 用户已批准中断并重启。第一次补修切换备份为D:/dsh_home/backups/decision-context-63a157f-20260922，精确安装34文件一致；PID843020。运行中核验发现活动回填阻塞启动，保持本轮修复推进，不将部署判为完成。

- 18:12恢复核验：407c59d精确安装34文件相同。翻译旧零效果草稿已通过reconsider标rejected且无旧Outbox，新决策重开原Task inputVersion2/run2；三条历史Task原Session缺失仍queued。权限Task同稿checkpoint因字段顺序误判，精确修复保留原reject审阅身份，正在全量回归。
