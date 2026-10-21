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
| T21 | [independent-coordination-recovery.test.js](../../../test/independent-coordination-recovery.test.js) — invalid schedule | service/time | 已通过；真实语言未执行 |
| T22 | [coordination-schedule-revisions.test.js](../../../test/coordination-schedule-revisions.test.js) — explicit same-slot replacement transfers current pointer and permanently fences the old occurrence | slot | 已通过 |
| T23 | [coordination-final-fault-matrix.test.js](../../../test/coordination-final-fault-matrix.test.js) — T23 due scan rollback | transaction/fault | 已通过 |
| T24 | [coordination-trigger-commands.test.js](../../../test/coordination-trigger-commands.test.js) — lost commit acknowledgement is reconciled by the original Task command receipt after restart | receipt/fault | 已通过 |
| T25 | [coordination-ledger.test.js](../../../test/coordination-ledger.test.js) — cancel wins send-permit CAS and stale query worker cannot publish after lease reclaim | lease/fence | 已通过 |
| T26 | [coordination-concurrency-contracts.test.js](../../../test/coordination-concurrency-contracts.test.js) — slot replacement, repeat scan and first claim linearize | concurrency | 已通过 |
| T27 | [coordination-concurrency-contracts.test.js](../../../test/coordination-concurrency-contracts.test.js) — concurrent cancellation and permit: | concurrency | 已通过 |
| T28 | [coordination-ledger.test.js](../../../test/coordination-ledger.test.js) — real SIGKILL after permit | process/notification | 已通过；真实送达不在本次范围 |
| T29 | [independent-coordination-native.test.js](../../../test/independent-coordination-native.test.js) — no-Topic scheduled query runs through Host recovery and the existing outbox without reopening the queried Task | native | 已通过 |
| T30 | [independent-coordination-recovery.test.js](../../../test/independent-coordination-recovery.test.js) — invalid schedule | service/scope | 已通过；真实语言未执行 |
| T31 | [coordination-schedule-revisions.test.js](../../../test/coordination-schedule-revisions.test.js) — expired one-time schedule terminates visibly; multi-year offline coalescing has an exact count | time/recovery | 已通过 |
| T32 | [coordination-final-fault-matrix.test.js](../../../test/coordination-final-fault-matrix.test.js) — T32 forward jump coalesces latest slot and backward clock plus restart cannot repeat accepted UTC slot | time/recovery | 已通过 |
| T33 | [coordination-final-native.test.js](../../../test/coordination-final-native.test.js) — automatic expired result refresh restores one outbox after restart | native/outbox | 已通过 |
| T34 | [coordination-migration.test.js](../../../test/coordination-migration.test.js) — compatible frozen mode survives restart and blocks coordinated claims and send permits without freezing unrelated work | migration/recovery | 已通过 |
| T35 | [coordination-final-native.test.js](../../../test/coordination-final-native.test.js) — automatic expired result refresh restores one outbox after restart | native/topology | 已通过 |
| T36 | [independent-coordination-native.test.js](../../../test/independent-coordination-native.test.js) — no-Topic scheduled query runs through Host recovery and the existing outbox without reopening the queried Task | native/outbox | 已通过 |
| T37 | [independent-coordination-changes.test.js](../../../test/independent-coordination-changes.test.js) — arrangement member context pages remain bounded and preserve persisted ordinals | service/context | 已通过；真实语言未执行 |
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

## 唯一外部前置条件

云端代码与程序验证无待办阻断。后续用户已选定并授权临时`openai-codex/gpt-5.6-sol`；恢复依赖后真实LLM-only路由首项返回账号不可用，doctor报告OAuth存储缺失，后续未执行。当前阻断为**该云端没有可用的既有真实路由账号**，且不允许本轮新增登录。详见[真实回放状态](./real-language-replay-status.md)。已备 `coordination-standard-model-adapter.mjs`，向其显式注入批准的LLM-only `ctx.llm`，无业务工具、TaskStore、群历史或发送器。

最小选项：一个现有provider/model，先4项固定合成样例（六任务、A后B、部分指代、明早9点），或最多16项全样例，每项一次标准stream、无自动重试，单次30秒默认超时。再比较第二模型需另计调用。仅发送合成消息/任务/成员/时间事实、协调协议提示与schema，不含真实用户/群数据、附件、私有源码或凭据。提供方内部重试与账单未知，不从样例数推算成本。步骤见 [语言回放runbook](../../ops/coordination-language-replay.md)。

默认报告16项均 `not_executed`、真实模型调用0；不能算真实语言通过。真实钉钉送达、生产迁移和部署检查属于明确未授权的外部范围，不是本云端候选的程序测试失败。候选不等于上线验收通过。

本分支未推送、未建PR、未部署、未合并、未发版，未访问百部。完整patch与测试日志在workspace交付。

