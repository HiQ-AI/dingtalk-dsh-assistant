# v1.3 云端候选与最终证据

基线 `main 94f99720836e134f0615dc7e02f0f4d4bd72b7e9`；2026-10-21 收尾时已重新 fetch 核实，未变化。分支 `feat/coordination-v1.3`，承接 `8843b4d`。

四阶段功能均已接通实际入口；没有已知尚未实现的首版业务合同。原文槽位现在持久保存 source unit 的 UTF-16 起止、逐字 quote、来源消息/refs；明确成员与待澄清项交错不改变序号，解决澄清填回原槽位。追加消息可用自身原文局部槽位接续全局序号；缺历史证据、追加映射有缺口或一项对应多个目标仍澄清，不补造索引。周期内部派生指令不计作用户成员序号。

以下51项的程序合同已完成确定性、实际原生入口或真实子进程验证。这里的“完成”限定为表中的协议边界：接纳三类行、到期四类行逐项写前/写后故障，COMMIT 前与持久提交后 ACK 丢失，CAS 竞争的两种顺序或三方六种提交顺序，以及关键外部交接的 SIGKILL。不是穷尽任意机器指令或无限线程交错，也不是上线验收。

最终相关风险组合38文件 **542 PASS、0 FAIL、0 SKIP**，包含实际打包、旧 v1 模块迁移、原生 Host 和强制退出恢复。最后来源结清/追加槽位补丁受影响组合 **83 PASS、0 FAIL、0 SKIP**，最后周期派生项回退/长原文读取修复组合 **55 PASS、0 FAIL、0 SKIP**；组合相互重叠，不累加。独立审查另复验长来源读取3项通过。测试分类校验覆盖292文件，git diff --check通过。未运行无关全量或 CI。

## T01–T51 证据

每行给出测试文件、实际测试名或展开变体前缀、层级。所有标题已核对出现在上述通过日志；机器可读清单见 [final-matrix.json](./final-matrix.json)。

| 项 | 测试文件 / 测试名（展开变体前缀） | 层级 | 程序 / 外部证据 |
|---|---|---|---|
| T01 | [coordination-final-native.test.js](../../../test/coordination-final-native.test.js) — competing actual ingress and recovery reserve one source, plan once and keep original receipt after restart | native/restart | 已通过 |
| T02 | [coordination-ledger.test.js](../../../test/coordination-ledger.test.js) — real process SIGKILL after third member commit resumes original six receipts without replay | process | 已通过 |
| T03 | [coordination-final-fault-matrix.test.js](../../../test/coordination-final-fault-matrix.test.js) — T03 acceptance rollback | transaction/fault | 已通过 |
| T04 | [independent-coordination-native.test.js](../../../test/independent-coordination-native.test.js) — real ingress reserves a no-Topic unit, independently plans A then B and dispatches original Owners from completion facts | native | 已通过 |
| T05 | [coordination-execution-proof.test.js](../../../test/coordination-execution-proof.test.js) — completion receipt, coverage proof and independent ordered event commit atomically and replay once | transaction | 已通过 |
| T06 | [coordination-execution-proof.test.js](../../../test/coordination-execution-proof.test.js) — consuming an old completion after reopen reads current truth and cannot make B eligible | recovery | 已通过 |
| T07 | [coordination-final-fault-matrix.test.js](../../../test/coordination-final-fault-matrix.test.js) — T07 cross-coordination opposing dependency producers | concurrency | 已通过 |
| T08 | [coordination-final-fault-matrix.test.js](../../../test/coordination-final-fault-matrix.test.js) — T08 cancelled arrangement cannot be resurrected by old apply or recovered wake and does not cancel original Task | recovery | 已通过 |
| T09 | [coordination-execution-proof.test.js](../../../test/coordination-execution-proof.test.js) — Host binds pending instructions despite caller empty ids; claim waits before locking while Owner controls remain available | execution | 已通过 |
| T10 | [independent-coordination-changes.test.js](../../../test/independent-coordination-changes.test.js) — member-level ambiguity preserves source ownership and | service | 已通过 |
| T11 | [source-dispatch-ownership.test.js](../../../test/source-dispatch-ownership.test.js) — accepted legacy decision cannot be claimed by coordination and retains original operation identity | resident | 已通过 |
| T12 | [coordination-summary.test.js](../../../test/coordination-summary.test.js) — unsent summary A superseded by active facts B can freeze A again, while an unknown permitted summary keeps its identity | notification | 已通过 |
| T13 | [coordination-execution-proof.test.js](../../../test/coordination-execution-proof.test.js) — running reorder requests read-only Owner assessment without revising or cancelling; safe point needs Host evidence | execution | 已通过 |
| T14 | [coordination-execution-proof.test.js](../../../test/coordination-execution-proof.test.js) — existing running input remains explicit prior scope, but a new continue input cannot inherit the exemption | execution | 已通过 |
| T15 | [coordination-ledger.test.js](../../../test/coordination-ledger.test.js) — source reservation and fixed member apply survive restart without replaying task mutation | receipt/restart | 已通过 |
| T16 | [source-dispatch-ownership.test.js](../../../test/source-dispatch-ownership.test.js) — route atomically reserves coordination unit; no Topic required and discussion remains separate | resident | 已通过 |
| T17 | [coordination-migration.test.js](../../../test/coordination-migration.test.js) — a real process killed after migration DDL but before version update leaves atomic v1 state and retries safely | process/migration | 已通过 |
| T18 | [coordination-final-fault-matrix.test.js](../../../test/coordination-final-fault-matrix.test.js) — T18 second supported writer refuses live owner and expired incarnation rejects coordination writes | writer/fence | 已通过 |
| T19 | [coordination-execution-proof.test.js](../../../test/coordination-execution-proof.test.js) — consuming an old completion after reopen reads current truth and cannot make B eligible | version | 已通过 |
| T20 | [independent-coordination-native.test.js](../../../test/independent-coordination-native.test.js) — real ingress reserves a no-Topic unit, independently plans A then B and dispatches original Owners from completion facts | native/notification | 已通过 |
| T21 | [independent-coordination-recovery.test.js](../../../test/independent-coordination-recovery.test.js) — invalid schedule | service/time | 已通过；固定合成语言回放通过（任务消息摘要，原 JSON 未导入） |
| T22 | [coordination-schedule-revisions.test.js](../../../test/coordination-schedule-revisions.test.js) — explicit same-slot replacement transfers current pointer and permanently fences the old occurrence | slot | 已通过 |
| T23 | [coordination-final-fault-matrix.test.js](../../../test/coordination-final-fault-matrix.test.js) — T23 due scan rollback | transaction/fault | 已通过 |
| T24 | [coordination-trigger-commands.test.js](../../../test/coordination-trigger-commands.test.js) — lost commit acknowledgement is reconciled by the original Task command receipt after restart | receipt/fault | 已通过 |
| T25 | [coordination-ledger.test.js](../../../test/coordination-ledger.test.js) — cancel wins send-permit CAS and stale query worker cannot publish after lease reclaim | lease/fence | 已通过 |
| T26 | [coordination-concurrency-contracts.test.js](../../../test/coordination-concurrency-contracts.test.js) — slot replacement, repeat scan and first claim linearize | concurrency | 已通过 |
| T27 | [coordination-concurrency-contracts.test.js](../../../test/coordination-concurrency-contracts.test.js) — concurrent cancellation and permit: | concurrency | 已通过 |
| T28 | [coordination-ledger.test.js](../../../test/coordination-ledger.test.js) — real SIGKILL after permit | process/notification | 已通过；真实送达不在本次范围 |
| T29 | [independent-coordination-native.test.js](../../../test/independent-coordination-native.test.js) — no-Topic scheduled query runs through Host recovery and the existing outbox without reopening the queried Task | native | 已通过 |
| T30 | [independent-coordination-recovery.test.js](../../../test/independent-coordination-recovery.test.js) — invalid schedule | service/scope | 已通过；固定合成语言回放通过（任务消息摘要，原 JSON 未导入） |
| T31 | [coordination-schedule-revisions.test.js](../../../test/coordination-schedule-revisions.test.js) — expired one-time schedule terminates visibly; multi-year offline coalescing has an exact count | time/recovery | 已通过 |
| T32 | [coordination-final-fault-matrix.test.js](../../../test/coordination-final-fault-matrix.test.js) — T32 forward jump coalesces latest slot and backward clock plus restart cannot repeat accepted UTC slot | time/recovery | 已通过 |
| T33 | [coordination-final-native.test.js](../../../test/coordination-final-native.test.js) — automatic expired result refresh restores one outbox after restart | native/outbox | 已通过 |
| T34 | [coordination-migration.test.js](../../../test/coordination-migration.test.js) — compatible frozen mode survives restart and blocks coordinated claims and send permits without freezing unrelated work | migration/recovery | 已通过 |
| T35 | [coordination-final-native.test.js](../../../test/coordination-final-native.test.js) — automatic expired result refresh restores one outbox after restart | native/topology | 已通过 |
| T36 | [independent-coordination-native.test.js](../../../test/independent-coordination-native.test.js) — no-Topic scheduled query runs through Host recovery and the existing outbox without reopening the queried Task | native/outbox | 已通过 |
| T37 | [independent-coordination-changes.test.js](../../../test/independent-coordination-changes.test.js) — arrangement member context pages remain bounded and preserve persisted ordinals | service/context | 已通过；固定合成语言回放通过（任务消息摘要，原 JSON 未导入） |
| T38 | [coordination-execution-proof.test.js](../../../test/coordination-execution-proof.test.js) — event write failure rolls back business completion, instruction fulfillment and receipt | transaction/fault | 已通过 |
| T39 | [coordination-final-fault-matrix.test.js](../../../test/coordination-final-fault-matrix.test.js) — T39 execution failure and notification failure remain separate while an independent member still receives its input | execution/notification | 已通过 |
| T40 | [coordination-final-fault-matrix.test.js](../../../test/coordination-final-fault-matrix.test.js) — T40 concurrent manual and recovery continuation share a new input identity and both claims respect dependency lock gate | concurrency/execution | 已通过 |
| T41 | [coordination-notification-freshness.test.js](../../../test/coordination-notification-freshness.test.js) — refresh wins: old payload and old outbox identity remain permanently unsendable after restart | notification/restart | 已通过 |
| T42 | [coordination-ledger.test.js](../../../test/coordination-ledger.test.js) — real SIGKILL after permit | process/notification | 已通过 |
| T43 | [coordination-final-fault-matrix.test.js](../../../test/coordination-final-fault-matrix.test.js) — T43 known-not-sent retry settles original attempt and races cancellation via same permit | concurrency/notification | 已通过 |
| T44 | [coordination-schedule-revisions.test.js](../../../test/coordination-schedule-revisions.test.js) — a started occurrence keeps its accepted revision while a future rule and recipient change is committed | slot/version | 已通过 |
| T45 | [coordination-concurrency-contracts.test.js](../../../test/coordination-concurrency-contracts.test.js) — slot replacement, repeat scan and first claim linearize | concurrency/slot | 已通过 |
| T46 | [coordination-notification-freshness.test.js](../../../test/coordination-notification-freshness.test.js) — permit wins: starting, recovered unknown and delivered candidates cannot be refreshed or resent | notification/CAS | 已通过 |
| T47 | [coordination-notification-freshness.test.js](../../../test/coordination-notification-freshness.test.js) — SIGKILL after atomic supersede but before outbox creation recovers the new frozen identity only | process/outbox | 已通过 |
| T48 | [independent-coordination-changes.test.js](../../../test/independent-coordination-changes.test.js) — resolving one of several pending members settles neither the other ambiguity nor its original source | service/recovery | 已通过 |
| T49 | [independent-coordination-changes.test.js](../../../test/independent-coordination-changes.test.js) — rejected source handoff reconciles frozen identity across | service/CAS | 已通过 |
| T50 | [coordination-final-fault-matrix.test.js](../../../test/coordination-final-fault-matrix.test.js) — T50 actual dispatcher stops unapplied tail after mid-batch version conflict without compensation | service/partial | 已通过 |
| T51 | [coordination-trigger-commands.test.js](../../../test/coordination-trigger-commands.test.js) — one authoritative business event may trigger two different actions but never the same action twice | trigger/receipt | 已通过 |

T03/T23 补充同文件 `T03 T23 due scan COMMIT ... acknowledgement failure reconciles exact original command` 两种提交故障；T07另有 `coordination-effective-graph.test.js` 的取消安排退出有效图回归；T32结合 `coordination-time.test.js` 的 DST skip/first 政策。T50结合 `independent-coordination-changes.test.js` 的显式整批待澄清零派发。T18保护受控 Host writer/owner incarnation，原始 SQL 仅作隔离故障注入，不宣称能对持数据库文件写权限的任意代码建立安全沙箱。

## 最终独立审查

审查修复：取消安排旧 applied/pending 边仍参加有效图；完整澄清转部分解决丢失未决项和整批屏障；已答原 source 的 dynamic settled 与 resident 结清投影不一致；旧记录周期子指令混入用户序号回退。原文槽位的身份、原话引用、澄清回填和多目标歧义分别独立回读。长追加来源可按unit/revision及offset读取完整原文，范围限当前群与协调单，拒绝无关来源。前轮的空 Owner 恢复、精确执行覆盖、未知效果、send-permit、slot/freshness 竞争合同保留。

运行中重排不会先 revise/cancel；周期授权不每轮向用户重确认；Owner默认astra与执行模型配置保持。协调模型仍使用显式独立 provider/model 配置，无静默继承或降级。

## 最终修复与真实语言证据

时间提案入口接纳显式时区 ISO 后规范为 UTC，持久化仍严格要求规范 UTC；精确时间断言未放宽。百部实测修复 `707766a74d5f313b2499c6636459760a3511f840` 已按用户批准的任务消息补丁整合为本地 `cbd249ed76cc6c632904a9a9a91585867f6476a8`。补丁字节、SHA256、五文件摘要与 tree `f24af35ec48a2b2dde55adbe4615313205400554` 全部一致。后续提交仅更新本文、证据与测试依赖映射，运行代码保持该实测树。

云端补跑相关 native/time/replay/slot 回归 **34 PASS、0 FAIL、0 SKIP**，触发、条件查询、并发、故障矩阵和恢复回归 **67 PASS、0 FAIL、0 SKIP**。独立审查未发现实质问题，另定向9项通过；这些有重叠，不与历史542项累加。上述542/83/55是此前候选证据，未在最后树机械重跑。日志与精确命令见 [修复证据](./repair-707766a.md)。测试映射只更新新增 import，不改 release 分类。

用户改用百部隔离环境后，真实 `openai-codex/gpt-5.6-sol` 修后冒烟4/4、完整16/16通过；20次修后成功响应耗时分别42,142ms与149,293ms，报告 totalTokens 合计194,842。含此前保留失败为25次 stream 尝试、24次完成（原候选4项中3通过1失败，另1次传输失败）。费用、提供方内部重试与底层网络请求数未知。以上来自父任务转交的验证摘要；原始报告 JSON 未导入云端，其摘要值未在云端重新计算，不能宣称云端再次跑过真实模型。详见 [真实回放状态](./real-language-replay-status.md)。

当前无已知功能缺口或程序验证缺口；51项均按有限协议边界逐项列证，不是穷尽交错或上线验收。剩余边界为真实报告原件未在云端归档、真实钉钉送达和生产迁移/部署未执行；后两者不在本请求授权内。既有云端鉴权/下载阻断未重试，不影响已完成的百部隔离回放结论。

本分支未推送、未建PR、未合并、未部署、未发版。云端未访问百部机器或复制凭据，仅接收获授权代码补丁及验证摘要；长期 Owner/执行模型配置不变。
