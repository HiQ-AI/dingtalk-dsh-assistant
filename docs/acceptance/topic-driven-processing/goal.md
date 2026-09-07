# Topic 驱动处理实施

> 状态：COMPLETE（本地实现与 PR 交付）
> Goal ID：topic-driven-processing
> 最近维护：2026-09-07T12:39:47+08:00
> 权威目标：goal.md

## 总目标

实现已批准的 docs/spec/topic-driven-message-processing.md：持久 Topic 分流、独立决策与恢复、Task 只引用 Topic 版本、结构化审阅、迁移和可观察界面，完成本地验证及 PR 交付。

## 完成条件

- 新协议完整替换旧消息级业务决策路径，保留授权、取消、来源及外部投递真实性。
- 存储迁移在隔离数据上实跑并可回退；核心交错、版本、重试和重启场景验证。
- Task 不再保存消息副本；API/Observer/假模型和说明同步更新。
- 本地完整测试、构建通过，feature 分支提交并创建自包含中文 PR，独立回读状态。
- 真实运行部署与对外消息测试分别记录；未经本轮具体发送授权不向真实群发送测试消息。

## 范围与约束

- 唯一实施工作区：D:/project/dingtalk-dsh-assistant-topic-processing，分支 worktree-topic-driven-processing。
- 主检出保持现状，不触碰已有 docs/tmp；方案从主检出复制到隔离工作区。
- 每群一个 Resident、每 Task 一个叶子；不引入第二套引擎或长期双写兼容路径。
- 原方案是开工前快照；实现取舍和新证据记录在本目录。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG0 | 数据与协议契约、迁移原型 | 冻结接口并验证真实 SDK 后端迁移 | 完成 | round-1.md；round-2/full-tests.log；round-2/native-dsh.json |
| SG1 | Topic 存储与归类 | 原子归类、固定版本、持久决策与幂等 Task | 完成 | round-1.md；round-2/full-tests.log；round-2/native-dsh.json |
| SG2 | Runtime 独立决策与恢复 | Topic 门禁、入站接收解耦、结构化内部审阅 | 完成 | round-1.md；round-2/full-tests.log；round-2/native-dsh.json |
| SG3 | Task 及通知输入迁移 | 版本校验、来源读取、回复回执与所有入口 | 完成 | round-1.md；round-2/full-tests.log；round-2/native-dsh.json |
| SG4 | API、Observer、假模型、文档 | 可查询/浏览 Topic，完整新协议运行 | 完成 | round-1.md；round-2/full-tests.log；round-2/native-dsh.json |
| SG5 | 回归、故障验证及 PR | 本地证据矩阵、完整回归、PR 回读 | 完成 | 233/233；PR #63 OPEN；CI 34084158313 success；round-4.md |

## 当前检查点

- 当前子目标：SG5
- 唯一下一步：本轮实现与 PR 交付完成；后续按迁移 runbook 独立安排部署验收。
- 未闭环项：真实模型语义质量、真实DWS、实际profile迁移及持续负载/全强杀点验证仍在矩阵中单列，不属于本轮已完成的本地交付证据。

## 进展

- 2026-09-07：用户批准实施。fetch 确认 origin/main 为 0925f0d，创建隔离工作树并复制已批准方案。

## 重大决策

- 先完成本地源码及隔离迁移验证；真实 profile 切换与外部发送需要分层确认现场，不把 mock 通过当真实交付。

## 重要信息

- 存储 SDK 单记录原子更新，无跨表事务。目标 domain version 7，旧 version 6 需明确离线迁移。
- 原有相关 Runtime 行为测试上轮 8/8 通过，仅为旧协议基线。

- 2026-09-07 实施中：真实 JsonStorageBackend/DomainFacility 隔离迁移、重复迁移、v6回退读取已验证；未改变实际profile。
- Native Inbox 测试识别历史插入不等于读取；投递恢复按 pending/user-message 判定，并在可用的 sessions.flush 耐久检查点之后推进 dispatchedInputVersion。
- 通知意图先写Outbox，再由bridge prepareOutbound执行撤回/发送；避免外部撤回成功但通知意图未保存。
- Resident 删除直写Task工具，统一Topic decision授权门禁；Web真实人工入口通过原子输入+Topic+decision写入，不能伪造钉钉来源。

- 第二轮：全量 `pnpm test` 215/215通过、0跳过；真实DSH 0.1.1-rc.2 + fake模型完成route/decision/3次checkpoint/result/4次内部审阅/通知，未外发。
- 全局Task提交队列不再等待Leaf创建；Task激活独立排队，可控慢A创建时B Topic仍完成。启动期间取消由持久状态拦截迟到Session，避免复活。

- 最终交付：PR #63 OPEN（https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/63）；CI 34084158313 对实现提交 522a269 全绿，233/233 tests，artifact 已下载核对。后续仅归档文档与证据，不变更源码。
