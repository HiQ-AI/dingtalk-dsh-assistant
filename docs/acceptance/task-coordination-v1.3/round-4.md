# v1.3 第四轮实施检查点

2026-10-21，承接 `8f4fdd5`，分支 `feat/coordination-v1.3`，main 基线仍为 `94f9972`。
本轮按父线程要求在安全检查点返回，不宣称全部上线门槛完成。云端连接正常，无拒绝或待审批操作。

## 四项业务合同

1. 成员级部分澄清接通实际消息入口：明确成员继续，待澄清项保留唯一来源归属且不 settled；逐项解决保持同一协调单。显式 allTogether 在全部澄清前零派发。
2. 周期 task-command 使用不可变授权模板，每 slot 冻结独立子指令和命令。重新核验目标、控制、run 版本及任务状态；原范围内无需每次确认，范围变化持久 blocked 并显示原因。兼容 context 不丢失，计划自己的有效版本推进可接续。未知提交沿原身份对账。
3. 聊天 query 提案回读权威事实、冻结答复、复用原 outbox/许可，不改 Task；包括成员要求、等待、回执、剩余结果。
4. 已运行任务重排先唤醒原 Owner 做只读预评估；Host 校验 safe_point 排空证明，或明确仅保留原 execution/inputVersion 继续。后续输入仍过依赖门禁。未判断或需澄清不先 revise/cancel，不追溯宣称严格顺序。

另补齐明确授权的“查询后未完成则继续”：到期先读新事实，已完成则 Task 完全不变，未完成才调用冻结的 preserve 继续命令；支持每日独立 slot。目标变化保存 blocked 与查询证据，不循环重试旧授权。

曾部分澄清的任意交错原文序号尚无 sourceOrdinal 映射；当前明确拒绝猜测 ordinal，要求实际任务或稳定 instructionId 的最小澄清，防止“第三个”误控明确子集中的第三项。

## 验证与独立审查

最终协调/持久化风险组合 **208 PASS、0 FAIL、0 SKIP**（14 文件）；最终真实原生入口与实际 tarball **14 PASS、0 FAIL、0 SKIP**（5 文件）。
另已完成共享持久化/Topic/通知/上下文风险组合 310 PASS；PR236 空 Owner 专项 3 PASS，保留原 session/wake 且不重放执行。测试分类校验覆盖288文件，git diff --check通过。
以上是各次实际运行，不相加当作独立场景总数，最后修复的定向复验见交接答复及 evidence 日志。
未机械重复全量，未触发 CI，未发真实钉钉消息。

独立审查修复：部分解决后同 ID 接纳通知不能重算成员数；resident superseded 候选终态投影；历史模板阻塞不影响新 slot 汇总；取消优先于未解决澄清；blocked 触发必须显示原因和剩余义务；自身周期 replan 使旧 applied 指令失效时保留 supersededBy，历史已 fulfilled 结果不误作当前依赖证明；第二次重排不能沿用上次输入豁免；未评估不能wait确认原wake，旧Owner complete不能绕过待评估，环检查包含其他待评估边。周期成员上下文固定100项分页并显示截断及真实持久序号。

真实 SIGKILL 新增覆盖：第三成员提交后恢复六项不重放；发送许可提交后假网络调用前/后崩溃均恢复 unknown，不用旧许可启动新发送。所有网络效果为隔离文件标记，不算真实送达。

## T01–T51 逐项状态

V=对应关键程序合同已有确定性实测；P=部分覆盖且明确缺少证据。二者都不代表真实语言或外部效果验收。
文件名省略 `test/` 与 `.test.js`。既有证据继承第三轮，本表列出当前结论与缺口。

| 项 | 状态 | 证据与仍缺维度 |
|---|---|---|
| T01 | P | source-dispatch-ownership/trigger-commands 唯一身份；跨进程双入口 resident 全链竞争待补。 |
| T02 | V | coordination-ledger 真 SIGKILL 第三项后，六项原回执恢复，各 context 仅一次。 |
| T03 | P | commit ACK、迁移/claim/permit/supersede kill；全部异步交接故障交叉点仍未穷尽。 |
| T04 | V | PR236 native 空 Owner 不发完成事件；正式 complete 才释放 B。 |
| T05 | V | execution-proof/trigger-commands：旧版本结果不结新指令。 |
| T06 | V | execution-proof：恢复先读当前版本。 |
| T07 | P | 全域环检查、pending reorder 图及版本 CAS；跨单多生产者复杂并发待补。 |
| T08 | P | 局部取消不取消 Task、旧实例不复活；全部旧 wake 组合待补。 |
| T09 | V | execution-proof/reorder-native：Owner 控制可恢复，新业务 claim 锁前门禁。 |
| T10 | V | changes/native：明确成员先执行、部分澄清逐项解决、原归属独占；不虚报整批完成。 |
| T11 | V | source-dispatch-ownership：旧 decision 原 operation 身份保留。 |
| T12 | V | freshness/delivery/summary：unknown 原身份，不新造通知。 |
| T13 | V | input-contract/ledger/reorder：未知影响不 revise，Owner 预评估只读。 |
| T14 | V | execution-proof：execution/inputVersion 精确范围、锁前等待、第二次重排撤销旧豁免。 |
| T15 | V | ledger/trigger：回执快路径同 ID 异内容拒绝。 |
| T16 | V | source-dispatch-ownership：讨论和协调分 unit 恢复。 |
| T17 | V | migration：实际 v1 历史库、DDL kill 原子恢复、旧程序拒 v2。 |
| T18 | P | 受控 owner/同连接/CAS 已测；原始第二连接非法 SQL 防护边界待复核。 |
| T19 | V | execution-proof：reopen 有效版本与 continue 轮次；周期自身版本接续。 |
| T20 | V | native/summary：Topic 承接排除，Owner 结果与跨任务事实分工。 |
| T21 | P | time 规则及过去时刻拒绝；实际模型时间语言理解未执行。 |
| T22 | V | schedule-revisions/concurrency：slot 跨版、扫描和替代唯一。 |
| T23 | P | occurrence/nextDue 同事务；完整事务各语句 crash 点待补。 |
| T24 | V | trigger-commands：每 slot commit ACK 丢失原命令恢复；query 只读白名单。 |
| T25 | V | schedule-revisions：旧 fence 结果拒绝。 |
| T26 | V | revision/future/unstarted、本次控制；改期/scan/claim 六种提交顺序。 |
| T27 | V | concurrency：取消与 permit 两种并发生产者定序，重启验证。 |
| T28 | P | 假发送/readback/kill unknown；真实钉钉未授权验证。 |
| T29 | V | native 查询不 reopen、不增 run、不唤醒；明确条件继续属于另存授权动作。 |
| T30 | P | 稳定成员/越群拒绝；真实目录与重名实际模型回放未执行。 |
| T31 | V | time/schedules：停机合并和串行；native 两个周期与 per-slot 版本。 |
| T32 | P | DST skip/first、UTC slot；完整时钟异常并发组合待补。 |
| T33 | P | unknown 不替代冻结 payload；自动 freshness/outbox 全故障链待补。 |
| T34 | V | migration：schema、活 owner、持久 frozen 均在副作用前检查。 |
| T35 | P | 无 Topic native 查询/新建/改口；Topic 删除归档的全部联测待补。 |
| T36 | V | native 同 outbox/permit/readback，不伪造实体。 |
| T37 | P | 有界原文/分页/截断可见；错误前置意图的实际模型回放未执行。 |
| T38 | V | execution-proof：版本、context、coverage 校验与完成事件同事务。 |
| T39 | P | 业务/投递分账、blocked 可见；双故障整批组合待补。 |
| T40 | P | continue/recover/hold 统一门禁；全部人工与恢复并发组合待补。 |
| T41 | V | freshness/changes/projections：旧 superseded outbox 永久拒发、投影不复活。 |
| T42 | V | ledger：permit 后假网络调用前后真 SIGKILL，恢复 unknown，旧/新启动均不能重发。 |
| T43 | P | 可信未发送同 ID 重试合同；同 attempt 取消并发完整组合待补。 |
| T44 | V | schedule-revisions/trigger：跨版 cursor/slot，周期 time.accept 回放身份。 |
| T45 | V | concurrency：修改/重复 scan/首次 claim 六种单 writer 提交顺序，重开后至多一项开始。 |
| T46 | V | concurrency/freshness：结果替代与 permit 两种顺序仅一方胜出。 |
| T47 | V | freshness：supersede 后新 outbox 前真 SIGKILL。 |
| T48 | V | partial/native：reserved/部分澄清旧链排除、不 settled；最后解决才结清来源。 |
| T49 | V | changes+native：交回 freeze/证明/CAS，unknown 不交回，真实旧 router 接续。 |
| T50 | P | allTogether 部分澄清零派发、新建同事务、冲突部分应用；全部中途失败汇总待补。 |
| T51 | V | trigger 联合分支、事件动作身份；native message/business-event/time 实际调用方。 |

## 环境证据与实施边界

语言回放入口：`scripts/coordination-language-replay.mjs`，固定合成样例与文档见 `docs/ops/coordination-language-replay.md`。
16项合成样例的默认报告全部为not_executed，实际模型调用0；回放器脚本测试不计为语言理解通过。
无模型适配器时不读凭据、不调用外部服务；报告未执行。脚本测试只证明回放器评分与输入隔离。
尚无获授权的真实模型适配器，真实语言质量、token/cost 和真实钉钉送达均属证据欠缺，未执行而非通过。
昨晚六任务完整原话未提供；合成六项不能冒充原话回放。

仍未闭合：表中 P 项的指定并发/故障证据、任意交错原文 ordinal 的直接解析（当前安全澄清）、协调模型默认选择/真实语言成本评估。
部署前活动任务检查及真实外部效果不在本轮授权内。本分支未推送、未建 PR、未部署、未合并、未发版。
