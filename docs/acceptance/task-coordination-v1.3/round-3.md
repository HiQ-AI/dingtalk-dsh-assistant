# v1.3 第三轮实施检查点

日期：2026-10-21。沿用 main 94f9972、分支 feat/coordination-v1.3；承接 5faad2e。
用户要求在安全步骤返回，本轮不是取消任务，也不是宣称首版已全部验收。
云端连接正常；未访问百部，另一线程的 main 部署不包含本分支。

## 本轮接通

- rejected 来源经过动态冻结证明回读、resident 冻结/generation CAS、动态 fence 确认交回。
  三处丢 ACK 后沿原身份恢复，unknown 拒绝交回；交回消息重新排入真实旧路由。
- 原安排 ordinal 固定到 memberIds；同协调单澄清回复生成新 revision，保留两条真实来源。
  pause/resume/cancel/append/reorder、计划变更和本次实例控制均接到独立消息入口。
  已生效要求不自动回滚，不以撤销安排取消 Task；已开始项目的追溯重排拒绝而非假装严格顺序。
- 聊天明确新建使用稳定 creationKey→taskId；Task 创建、成员安排同事务，但没有创建 wake。
  依赖/时间释放后 task.coordination.start 才持久唤醒 Owner；force Owner 和 execution claim 仍受 hold/gate。
- 立即消息使用 message occurrence，正式完成事件使用 business-event occurrence，到期使用 time occurrence。
  无 schedule 的分支不填虚构时间字段；同事件不同动作不互吞，业务事件在 apply 前再读当前证明。
- 定时 task-command 冻结原 envelope/摘要/目标版本，只认原回执，不从 timer resume 会话。
  query 与 task-command 分别执行；任务命令结果明确是要求接纳回执，不是业务完成。
- 整单事实聚合保存成员要求/回执/等待/证明、计划、实例、作业和剩余结果，业务与投递分账。
  终态跨任务汇总有稳定 summaryRevision；前条 unknown 时不换身份发送新总结，未许可陈旧候选永久退役。
- 迁移 CLI 使用真实 v1 摘要 CAS，DDL 在同连接事务中执行。真实 94f997 v1 模块生成历史库，
  实际旧程序拒开 v2；DDL 后 SIGKILL、活 owner、未排空群、marker/epoch 不匹配均有隔离演练。
  enabled:false 只关闭接纳并保留归属续办；持久 frozen 在 replay 前设置，claim/发送许可也被围栏。
  运行步骤见 [迁移与兼容回退 runbook](../../ops/coordination-ledger-migration.md)。

## 实测

- 程序/兼容风险组合：350 PASS，0 FAIL，0 SKIP（14 个相关文件）。
- 原生入口与实际 npm tarball：10 PASS，0 FAIL，0 SKIP（3 个文件）。
- 原生新建覆盖立即 A→B 与到时启动；普通原 Task 续办、无 Topic 查询及 outbox 沿第二轮合同验证。
- 新 handoff 原生测试最初超时：原因是脚本测试错误地同时提供旧 Topic decision 两个 union 分支。
  修复测试后真实交回/重路由通过，并保留调用次数上限防脚本无限循环。没有删除产品断言。
- 另一初期集成运行使用修改前 context，暴露非 lossless JSON 工具输出；统一 clone 消除 undefined 后复验通过。
- 最后变更定向安全子集：32 PASS（trigger/migration/changes/freshness），独立审查修复后的汇总测试：4 PASS；与上述组合存在重叠，不累加计数。
- 汇总修复覆盖逐项全取消、未许可候选 A→B→A 再冻结、unknown 保持身份，以及历史 Owner 阻塞不覆盖已完成/取消事实。
- 周期 task-command 尚缺逐 slot 新授权模板，现明确拒绝接纳，避免重复旧指令伪装周期执行；每日/每周只读查询支持不受影响。
- suite-map 更新到 283 文件，检查守恒；git diff --check 通过。未机械重复全量，未触发 CI。
- 所有模型为隔离脚本适配器，所有发送为假发送端。没有真实模型理解或钉钉送达证据。

## T01–T51 当前覆盖

V=相应关键确定性合同已有实测；P=部分覆盖，表内给出仍缺维度。V 不等于外部效果或上线验收。
证据文件均位于 test/；本表继承第二轮证据，只列本轮相关补充，不用测试总数代替场景。

| 项 | 状态 | 证据及剩余范围 |
|---|---|---|
| T01 | P | source-dispatch-ownership、trigger-commands：CAS/稳定身份；跨进程双入口全链竞态待补。 |
| T02 | P | coordination-ledger 六项第三项后恢复；整批真实进程 kill 点位待补。 |
| T03 | P | changes/recovery 丢 ACK、migration/freshness SIGKILL；所有异步点位交叉矩阵待补。 |
| T04 | V | PR236 native 空 Owner 无 complete event；A→B native 仅正式完成释放。 |
| T05 | V | execution-proof、trigger-commands：旧版本/旧事件不结新要求。 |
| T06 | V | execution-proof：恢复消费先回读当前版本。 |
| T07 | P | ledger 全域环检查及 change CAS；复杂跨单并发竞争待补。 |
| T08 | P | changes 局部取消、occurrence 控制不取消 Task；所有旧 wake 组合待补。 |
| T09 | V | execution-proof、new-task native：控制可用、业务 claim 锁前门禁。 |
| T10 | P | 局部控制与部分应用事实；单一协调 unit 内部分语义歧义逐成员接纳待补。 |
| T11 | V | source-dispatch-ownership：旧已接纳 decision 保持 operation identity。 |
| T12 | V | notification-freshness/既有 delivery：unknown 不换身份。 |
| T13 | V | task-input-contract/ledger：preserve 与不确定分类无破坏。 |
| T14 | V | execution-proof：inputVersion 范围、空 ID 不能绕过、锁前正常等待。 |
| T15 | V | ledger、trigger-commands：已有回执同 ID 异 payload 亦拒绝。 |
| T16 | V | source-dispatch-ownership：混合讨论/协调 unit 独立及恢复。 |
| T17 | V | migration：真实 v1 历史库、DDL SIGKILL 原子恢复、实际旧程序拒 v2。 |
| T18 | P | owner/quiescence/digest 事务 CAS；原始第二连接非法 SQL 的完整防护边界待复核。 |
| T19 | V | execution-proof：reopen 生效版本与 continue 新输入范围。 |
| T20 | V | native：旧 Topic 承接排除、Owner 结果与整体终态汇总分工。 |
| T21 | P | time/changes：规则及过去时刻拒绝；真实“9点”语义回放待许可。 |
| T22 | V | schedule-revisions：slot 跨 revision、重复扫描及替代。 |
| T23 | P | occurrence/nextDue 同事务；全部事务故障注入点待补。 |
| T24 | V | trigger-commands：真实 commit 后丢 ACK 按原 receipt 恢复；query 只读。 |
| T25 | V | schedule-revisions：job fence 与迟到结果拒绝。 |
| T26 | V | future/unstarted 修订、旧接纳版本、本次控制合同及入口已接通。 |
| T27 | V | notification-freshness：取消/许可两种定序。 |
| T28 | P | 假发送/readback 不确定性已测；真实钉钉未授权验证。 |
| T29 | V | native 查询不 reopen、不加 runSequence、不唤醒被查 Owner。 |
| T30 | P | 已观察稳定成员 ID、缺失/越群拒绝；真实成员目录及重名语言待补。 |
| T31 | V | schedule/time：多年停机精确合并、串行与单个等待积压。 |
| T32 | P | DST skip/first 和 UTC slot；全时钟异常并发组合待补。 |
| T33 | P | freshness：unknown 不刷新；自动 refresh+resident outbox 全故障链待补。 |
| T34 | V | migration：旧 v1 真拒 v2，活 owner 与持久 frozen 在动作前阻断。 |
| T35 | P | 无 Topic 三条 native 闭环；Topic 删除/归档的全部联测待补。 |
| T36 | V | native query 与 tarball：同 outbox/permit/readback，无第二发送器。 |
| T37 | P | 有界原文与安排分页、context 必读；真实错误意图回放待许可。 |
| T38 | V | execution-proof：正式 complete 当前版本/上下文/coverage 与事件原子提交。 |
| T39 | P | 聚合分账且独立成员保持；业务与通知双故障整批组合待补。 |
| T40 | P | continue/recover/creationHold 统一 gate；全部人工竞态组合待补。 |
| T41 | V | freshness/changes：取消或 superseded 旧 outbox 永久拒发。 |
| T42 | P | permit 后重开 unknown；网络调用前后完整 kill 组合待补。 |
| T43 | P | 原可信未发送重试与新取消门禁；同 attempt 竞争组合待补。 |
| T44 | V | schedule-revisions：future 改版继承 cursor/slot。 |
| T45 | P | slot/replacement/claim CAS；三方多进程故障组合待补。 |
| T46 | V | freshness：许可与结果替代至多一方胜出。 |
| T47 | V | freshness：supersede 后 outbox 前真实 SIGKILL。 |
| T48 | V | changes native：reserved/clarify 旧链排除且不 settled。 |
| T49 | V | changes 8 项恢复协议+native真实 handoff/旧 router；unknown 拒交回。 |
| T50 | P | new-task 同事务预检/创建、部分冲突；所有中途失败汇总场景待补。 |
| T51 | V | trigger-commands 联合字段/去重；native message、business-event、time 三种实际调用方。 |

## 尚未满足完整首版候选的事项

1. 同一协调 unit 的部分语义歧义目前仍需拆分 unit 或澄清整项，尚无成员级 needs_clarification 提案。
2. 周期 task-command 尚缺每个 slot 的独立授权模板/冻结新指令合同，现以明确错误拒绝接纳或改成周期，避免复用旧指令回执静默报每轮已执行。每日/每周只读查询仍支持。此缺口需继续实现，不能据此删减首版范围。
3. 普通对话直接查询“整体还欠什么/为何等待”的事实视图可从 context/aggregate 读取，但尚缺专门 query 提案与冻结答复入口。
4. 已开始工作的顺序改口目前保守拒绝追溯重排；需补 Owner 无业务变更的预评估/安全点处理闭环，不能伪称严格顺序已追溯成立。
5. 首版模型默认值仍采用显式 provider/model 配置，不静默沿用 astra；真实语言隔离回放和成本评估未执行。
6. 上表 P 项故障/并发维度及真实外部效果仍未全部验证。需继续实现/验证，而非把 360 项通过当作完整首版验收。

现无访问拒绝、待审批动作或不确定真实外部效果。遵照父线程要求在安全检查点返回后继续，不推送/PR/部署/合并/发版。
