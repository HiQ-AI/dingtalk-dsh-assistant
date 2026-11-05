# 第 15 轮：本机部署与固定消息批次复核（阶段记录）

日期：2026-11-05

## 结论与范围

本轮在合并源码 `960ddadc1aae64877355a344aa36cf8aa6f410b8` 上完成双包本机部署，并对固定20条做部署后只读对照。安装及切换回执、双包与安装文件核对、最终健康回读通过；但运行态曾发生 `DYNAMIC_SOURCE_CONFLICT` 导致 degraded，之后自然恢复，具体冲突分支与复发风险未收敛。固定20条在 ID、version、processingState 口径下与基线相同，5条无 scope/clarification 的 hold 仍在，未见业务推进；该比较不表示完整投影未变或 hold 已恢复。

实际包 smoke 首轮为 1/2，个人技能任务超时；诊断定位到合成 driver 未消费 `nextCall` 的补读续接。仅公共测试 fixture 修正后，实际 Assistant 包单项按原断言及30秒时限复验1/1通过；首轮失败与中间失败均保留，不将定向复验改写为整文件一次全绿或性能改善。确认替换类型门禁仍未实现，round-13 的语义/审阅与性能结论不变。

本轮未重放业务、发送真实钉钉消息或恢复任何 hold。下述详细 validation 以 C 的去标识 JSON 为权威结果，并记录 D 的独立回读；不写整体 `report.md`。

## 诊断摘要（routing-review 回报）

- 11 条 processing 来源均已路由，分布于两个 Topic；其 Topic 版本/processed 计数分别为 56/49 与 11/4。最新决策提交均为 `routing-required`。
- 5 条 needs-context 来源缺少 scope，形成持久未知范围 hold。D 报告的部署前安装版为 2.3.0：`topic-model.js:5-7`、`store.js:1042` 与 `topic-runtime.js:413/763/819` 分别体现 Topic 屏障、接纳前拒绝及 monitor/续行等待；安装文件 SHA256 分别为 `65f3575676c17a7b565a1eaccf2457cb2fc5b465020cfa74baa6bdc45c1cc98d`、`2b7491db088e0700f0f5bc249e16197c57a9730e6bc929167f516873890b6a89`、`ef22180e348545ac2233f10432d869cbf30c21e223dfd0db13075a9ce5c40619`。这些是部署前安装版证据，不能与合并源码行号混用。Lead 另核当前合并版 `960ddadc1aae64877355a344aa36cf8aa6f410b8` 的对应合同位于 `topic-model.js:5-7`、`store.js:1046`、`topic-runtime.js:451/852/912`；当前工作树源码 SHA256 分别为 `662957c8ff734108fffbc37859024f9094013b327624108294c77d9d3bf97f09`、`4ae4e746613982f43222c66b9b70bdc1f705814485a642c9c37843de80ab9834`、`29324b73058fb7ff6c92ede8b51d326b5b19d1a6d9f4ad621451c993eb45c5da`。这组证据支持归属/恢复阶段阻塞，不归因于 Owner 或通知执行；仅适用于本批来源。
- 两个精确 session 各有 7 次 start 与 7 次 end；工具调用/结果配对分别为 19/19 和 20/20，终态均为 blocked。无 pending attempt、`nextRetryAt` 或 `lastError`，因此没有报告为耗尽重试。
- 4 条 processed 来源均是 `fixedTopic=out-of-scope`、带 `handledAt` 且 canonical 状态 completed；这证明职责外处理终态，不证明通知送达。
- 对 20 条来源精确查询 current/archived notification 与 Resident outbox，未发现直接 `sourceMessageId` 关联。该结果不等同于不存在间接关联或发送历史。
- 基线之后有一条来源再次自然进入 hold；该项基线为v2/needs-clarification、hold epoch 1，01:20:53部署前自然变为epoch 2。部署后仍为hold；此变化不计为部署导致，也不表示该项恢复。两个会话没有未结回合证据，也不足以证明整个实例可安全切换或已静止。

## 候选因果比较

- 未结束的模型/工具调用：两个精确 session 都有 7 次 start/7 次 end，调用与结果分别 19/19、20/20 配对，末端为 blocked，且最后工具结果为 `routing-required`。这些事实反证“所观察到的回合仍卡在未返回的模型/工具调用”；结论只限这两个 session。
- Owner 或通知执行卡住：该批最新 decision 仍是 `routing-required`，两个 Resident request 均 pending、attempt 0，没有 `nextRetryAt`/`lastError`；20 条精确查询也没有直接 `sourceMessageId` 关联的 current/archived notification 或 Resident outbox。证据不支持“已接纳 Owner/通知动作后执行卡住”；缺少直接关联不排除未查询到的间接关联。
- 未知范围 hold 上游阻断：5 条 needs-context hold 缺少 scope 且没有 clarification；来源状态、`routing-required` 结果及相应版本的 Topic 屏障/接纳拒绝/monitor 等待逻辑相互吻合，是本批最有支持的解释。范围限固定 20 条与两个 Topic，不证明全实例静止或所有其他根因不存在。

## 部署与产物验证

C 首轮原生 `-Check` 在 package 校验阶段失败，未停机、未切换；首轮失败保留。原因定位为工具环境差异：C 的 PowerShell 使用 GNU tar，Lead 的 PowerShell 使用 System32 `bsdtar`；Lead 在其原生 PowerShell 沿同参数重跑后 `-Check` 通过，未改 PATH、cwd、脚本或参数。D 独立回读确认预检为 `checkOnly`：`writes=0`、`signals=0`、`candidateOnly=true`、`drained=true`、`quiescent=true`，pending tasks/executions/groups 均为0。预检时 `ownerReleased=false`，不代表进程已退出或租约字段已清理。

Lead 随后以 SIGINT 排空旧 PID 47836；D 核实旧进程已退出、无剩余 descendants、runtime port closed，但 `ownerReleased=false`、`staleOwner=true` 保留；3条 `unknownOperations` 和0条 `unknownNotifications` 保留，未伪造完成。双包版本均为2.3.0：Assistant SHA256 `b8066ac306213ab161cfdc97d7919473807ae72e63e701b8404348bee1958ae8`（95个校验文件），Observer SHA256 `84e114942dab9b4ef60f1b6cf9f40fae889181a5c9d52296bd778aa84d24c1f2`（4个校验文件）；D 独立确认缓存、packed、source、installed逐文件哈希一致。新 PID 60180 于 `2026-11-05T09:55:55.397759+08:00` 启动，两个端口同 PID，自启任务启用，未创建备份；cordis patch SHA256为`1f2c3b27f47d2635c5c02c22c5965ec6c1d12b3516c86d77de7a8a4813e59f55`。

D 只读核对数据库与初始化 marker 的 instanceId、initToken、ingressEpoch相符，phase为initialized、schema为3、当前 owner 指向新 PID；marker mtime早于部署，且无部署前marker摘要基线，因此不声称前后逐字一致。`topicRouteModel` 与 `topicDecisionModel` 均为null，未改模型配置。

## 实际包 smoke 与 fixture 单项复验

Assistant 实际包 smoke 首轮两项为1 pass / 1 fail。resident提取启动健康项通过（7850.1938 ms，health verified 7774 ms）；个人技能任务项在原30秒业务时限以 `TEST_STAGE_TIMEOUT` 失败，最后观测 `runtime-imports-ready`（6810 ms），未到 `native-host-ready`/ingest，cleanup正常（261 ms）。首轮 TAP `round-15/package-native.tap` SHA256为`5332a56376029dc0bbbf68ff0764c1473fc55c00322bc7e3dd6f4fc3dcf838c9`。

第二次单项复验仍失败：观察到 host-ready 5578 ms、ingest 5609 ms；Task 与3个execution均 completed/drained、`pendingWakes`为空，455次同一 `coord-decision`，没有 `isError=true` 工具结果。该轮证实任务已推进到host/ingest，但未完成原断言；不能与首轮停在 `runtime-imports-ready` 的失败合并。

第三次诊断运行计261次模型调用，末8次均为 `group_decision_submit`、`isError=false`、`context-required/topic_decision_context_unread`，`nextCall`指向同一request的summary offset 0。D据此确认合成driver未消费补读续接并重复循环；这解释该诊断轮，不与第二次455次复验或首轮超时混写。诊断过程文件发生37d52→edcf8230变化，不绑定单一blob；拒绝结果摘要保留在最终validation中，不引用可变诊断文件哈希。

C 还原临时诊断改动，产品包源码仍为`960ddadc`。唯一修复是公共测试fixture的5行适配：仅在当前可见末个tool result为context-required、工具名和requestId吻合时，原样传递 `nextCall`；fixture Git blob为`0e4f8ce62072d226eb16f2518d57819b91c502b8`，package test Git blob为`e123bcf71a0d6de357657265f3acb63362894d56`。D审阅当前请求/连续分页及不碰旧receipt的边界。

修后实际Assistant包单项按原30秒时限及原断言为1/1 PASS：`business=27559 ms`、verified 27558 ms、native-task-idle 26492 ms、cleanup 330 ms。修后 TAP `round-15/package-task-fixed.tap` SHA256为`6f0d800f75a0cab7ef7edbb88f63dac838a74fd8f7246f844d7b7f873ca3e6ed`，执行前后冻结回执已绑定。该定向复验不改写首轮1/2或中间单项失败，也不代表整文件一次2/2、产品代码修复或性能改善。
## 部署后运行态与固定批次对照

脚本初始回读为 health ok、`inboundProcessing=true`、DWS bridge healthy；随后 D 于02:03/02:05观察到 degraded、`inboundProcessing=false`、bridge unhealthy，一群 backfill 报 `DYNAMIC_SOURCE_CONFLICT`，listener仍ready。02:10:05.213Z两群 backfill 成功并自然恢复，无重启或业务重放；Lead 02:12:32.853901Z独立回读为 ok、inbound/bridge healthy、recoveryIssueCount 0、两 listener ready、两 backfill成功且双端口仍属 PID 60180。保留初始ok→退化→自然恢复时序；仅能证明这些时点的状态，冲突具体分支未收敛，不能保证不复发。

固定批次基线 `2026-11-05T01:19:00.242Z` 与部署后 `2026-11-05T02:11:35.078Z` 精确匹配相同20条的 ID/version；`changes=[]`只比较 ID、version、`processingState`，不表示完整投影或 hold 字段均不变。状态为11 processing、5 needs-clarification、4 processed，未观察到新接纳决策；T1为revision/processed/summary/latestDecision 56/49/49/49，T2为11/4/4/4。5个 hold 仍无 scope/clarification，直接关联的 current/archived notification 与 Resident outbox 均为空。833在基线为v2/needs-clarification、hold epoch 1；epoch增至2的变化已证发生于01:20:53部署前，不能归因于部署。部署和健康恢复均未解除这些 hold；本次没有恢复或唤醒来源。

另有独立的841 backfill诊断，不属于固定20条：一次 `mget` 投影与canonical不同，但不是实际range接口输入；缺异常栈及真实输入，无法确定 `DYNAMIC_SOURCE_CONFLICT` 分支根因。不得把841并入固定批次或据此定性所有 backfill。

## 恢复与部署边界

未知范围屏障不得放宽。需要真实补充范围，或由有权限人员确认完整 scope 后，通过带 `messageVersion` 与 `epoch` 的正规本地 routing-hold 入口恢复。该入口可能触发 `kickGroup`；本阶段未执行，亦未获授权代为恢复。

本轮已完成部署、双包安装回读及固定批次对照，但不等同整体产品验收：未验证真实钉钉发送、Owner业务完成、普遍性能目标或完整冻结回归。B 的 confirmation 替换类型门禁仍未实现；round-13 的773共同语义失败、780/783 candidate实质回复误替换与性能观察保持原结论。不得以restart或健康自然恢复推断hold已恢复，也不得retry、replay、wake、cancel或改账。

## 证据与后续

Lead 已独立核对部署前去标识基线摘要：固定 20 条、`observedAt=2026-11-05T01:19:00.242Z`、SHA256 `8f485479928e362d3461ef23091bb5e729a141701c7ca386b6d800850d111ab9`。本报告只记摘要 hash 与采样时间，不复制原始输入、业务/身份数据或 session ID。两个 session 的末次 blocked 时间分别为 `2026-11-05T01:12:21.563Z` 与 `2026-11-04T11:51:16.178Z`；其后有一条来源于 `2026-11-05T01:20:53.021Z` 自然再次进入 v2/epoch 2 hold。安装版与合并版源码 hash/行号按“诊断摘要”区分，不能混作同一版本证据。

C最终去标识证据 `round-15/validation.json` SHA256为`2a20d103713d175e7603362d4c0951cc218e08514e21cd4249ea2f680c629cd0`；首轮 `round-15/package-native.tap` SHA256为`5332a56376029dc0bbbf68ff0764c1473fc55c00322bc7e3dd6f4fc3dcf838c9`；修后定向 `round-15/package-task-fixed.tap` SHA256为`6f0d800f75a0cab7ef7edbb88f63dac838a74fd8f7246f844d7b7f873ca3e6ed`。最终 JSON 为双包、健康时序、固定批次与残余限制的详细记录；本报告不复制原始输入、消息内容、身份或session ID。round-15证据目录只保留最终JSON与上述两份必要TAP；可变中间诊断附件不保留在该目录，拒绝/driver循环摘要仍由本报告与最终JSON记录。

再生成配方：在合并源码`960ddadc1aae64877355a344aa36cf8aa6f410b8`分别执行 `pnpm --dir packages/dingtalk-dsh-assistant pack --pack-destination ../../docs/tmp/<唯一目录>` 与 `pnpm --dir packages/dingtalk-dsh-observer pack --pack-destination ../../docs/tmp/<唯一目录>`；设置 `RELEASE_PACKAGE_DIRECTORY` 指向Assistant tarball所在目录、`DSH_NATIVE_TEST_PROFILE` 指向原profile，再于Lead的原生PowerShell/System32 bsdtar环境执行 `node --test test/task-session-package-native.test.js`。复现修后单项需同时带公共fixture blob `0e4f8ce62072d226eb16f2518d57819b91c502b8`；fixture不属于生产包。生成的临时pack/extract目录验证后清理。

矩阵 round-15 仅标记定向 smoke、部署/回读及固定批次观察的实际范围；全量冻结回归仍为部分，真实模型语义/性能未新增测量，B类型门禁未完成。round-13旧失败不覆盖；不据此宣称整体PASS。
