# 第 13 轮：真实模型反证与评测初态修复（阶段记录）

日期：2026-11-04 至 2026-11-05

## 当前结论

本轮记录 773 的真实模型共同语义反证、774 首轮评测初态缺账及修复后复验，以及五例真实 provider baseline/candidate 配对。五个配对均已结束并经 D 审阅：773 两侧共同语义 FAIL；774（修复后）与 778 在本次有界范围内通过；780、783 的动作/授权/receipt 与受理回复正文通过，但 candidate 审阅/去重选择未通过，存在替换既有实质回复的退化。774 初轮缺账失败仍单独保留。总计有效配对 streams 为 23→37。真实钉钉送达、Owner 完成和总体性能均未验；不把验收动作 accepted 外推为历史归并或审阅选择正确。round-1 至 round-12 的记录与矩阵格保持不变。

## 773：真实模型语义反证

baseline 与 candidate 均取得结构终态，决策均为 completed、`actions=[]`，Task 未变，隔离 send/readback 各 1，Owner run attempt 为 0；stream 分别为 8 与 5。baseline 还出现两次 tools/execute `isError=true` 与一次 `invalid-arguments`，candidate 的 `isError=true` 计数为 0；这些是工具调用错误计数，不等同网络/provider 传输错误。D 的语义审阅确认两侧共同将较新的部署错误归因到较早修复，故本例语义结果为 FAIL。结构及授权合同正确不抵消语义失败；共同错误也不能作为候选退化或性能改善的证据。

原始脱敏 provider 回执为 `docs/tmp/semantic-latency/773-baseline.json` 与 `docs/tmp/semantic-latency/773-candidate.json`。本机读取时两文件 SHA256 分别为 `d012e001adb6e22457588e906375a3a405a3d6070c7812105275c3682714907e` 与 `e0f63d1c612234c3315cfbc4873bd82fa21255b317cd2ce61165663b48178ae2`。provider module 与 harness 分别绑定 `99b5c20830a52f69641df8a18a39206079b0c725201958cce2c4a934f1d4f7cd`、`c036b9b9b2ab3196f9bde4939226a9bae4f239ebd7ba580d1f58426313c8d089`；两侧产品源码哈希不同，不能说成相同源码运行。

## 774：初态问题、修复及复验

首轮 baseline/candidate 的评测初态均缺 canonical source/admission；两侧 Route 提交均 `accepted`，不能说 Route 被此门禁拒绝。baseline Decision 提交 accepted；candidate 首次 Decision 为 `review-required`，再次提交后 accepted。随后两侧规范 reopen operation 被 `TASK_TOPIC_SOURCE_VERSION_MISSING` 阻止，关联 decision 与 operation 终态均为 `blocked`；Task 未变、receipt 为空、隔离 send/readback 与 Owner attempt 均为 0。该共同失败归因为 seed/fixture 漏账，门禁拒绝符合合同，不记作模型语义失败或 candidate 独有退化。此首轮失败保留，不与修复后复验合并成一次样本。

后续基线与 candidate 真实 provider 复验分别记录在 `docs/tmp/semantic-latency/774-baseline-recheck.json` 与 `docs/tmp/semantic-latency/774-candidate-recheck.json`。两侧均结构完成：decision completed、单个 reopen applied、receipt 存在，receipt 均绑定原 Task，revision/runSequence 2→3；隔离 send/readback 各 1、empty cancel 1、Owner run attempt 1 且均在执行前拒绝，实际 Owner 执行 0。stream 分别为 3 与 4；baseline 一次 accepted，candidate 一次 review-required 后补 replace 重提（`isError=false`），未另行调用 `review_get`。D 已独立审阅：在本次有界输入下，事项归属、原 Task 续办、授权及回复通过。candidate 的再次提交不改变该结论；不据 stream 3→4 推断整体提速。C 报告的 provider blob 为 `9cec86108f334f657e3d78f140237f60affeab68`，对应 SHA256 `594117071b76597bc123ce55b21b036c92ead69107ddaa9ecb92074c5c4f0cc4`。本机读取时两份脱敏回执 SHA256 分别为 `10a41efc520ef9604d3bfef833f8201ff0f6544c2827050bb5b40c2e4edb82bf` 与 `c2c95c2c2b75d6bb2a8ecc68e7e1f4fdf3a53c4f4a4059e10c2680eb0c54fb96`。边界：两条审阅来源缺失，本轮不能证明完整去重、附件处理、Owner 完成或真实钉钉送达；该结论仅适用于本例提供的有界输入。

## 774 零付费终态与 check 绑定

零付费 Host 最终新运行记录 `docs/tmp/semantic-latency/774-offline-final-terminal.json`，SHA256 `dc145045e1de30e6703243544d274be78319552756c5af9ce4b8c0a0106928bb`；D 已独立核验回执及 predicate。该次 `terminalValid=true`，decision completed、单个 reopen applied、receipt 存在、revision 2→3；隔离 send/readback 各 1，Owner attempt 1 / denied 1 / actual execution 0，empty cancel 1。Host close 后收集的 Route 1 次及 Decision 2 次请求均只含当前消息。离线脚本 blob 为 `98c3ce92b6f7be7bbc6c718f4ac4098db0bf2293`，bounded helper 为 `8e30bdd48f9569d280ff6946e588bd006f1b3579`，isolation helper 为 `91214caa6197b7988272ba29213353f4406e9a9f`。

零付费路径还保留两项隔离实现修正史：早期 Route schema 调用因 `routes.0.units.0.topics.0.revision` 命中 `unrecognized_keys` 返回 `invalid-arguments`，移除不支持的 `revision` 后 Route 被接受；该首轮 offline blob 未记录，不能绑定精确源码。empty-cancel stub 的检查条件过严，导致两次失败后才修正；这些是 harness/schema 失败，不是模型语义结果。最终新跑回执中 `emptyCancels=1`。旧失败记录均保留。

初次 `terminalValid=false` 的回执 `docs/tmp/semantic-latency/774-offline-first-terminal.json` 原样保留：当时错误地把无动作场景的零 Owner attempt 条件用于有动作 reopen 场景，且没有精确 offline blob，不能绑定为精确源码终态；它不是最终新运行的结果，也不能被改写成从未失败。

D 独立核验的 `docs/tmp/semantic-latency/774-side-checks-v2.json` SHA256 为 `4affb92e86195b3816c9d3abceaf3ebbb28325906058502e019e9bdf04ad2ede`。v2 baseline/candidate 均为 `mode=check`、`modelCalls=0`、`sideEffects=false`；同 provider/model/low/config/profile/provider module/harness、相同 fixture 与来源投影，四项评测依赖 SHA 匹配。来源投影哈希为 `ae2a0216cea47f1d55030489e969b6ed49f9d767b5e76a4b675efbf35bad19dd`，fixture 哈希为 `54ae4c1747a48476d2f39bf2698569266bb920d4e0b5dabf9f8959a07b3e0b22`。两侧产品源码哈希不同，符合 baseline/candidate 预期差异。旧 v1 绑定 `662f` 属历史，不作为当前 provider 实跑绑定。check 通过仅证明评测初态及执行依赖一致，不证明真实语义或性能。

774 零付费 Host scope 有界：52 个历史来源、其中 8 个含资源、17 个缺 timestamp；资源仅投影 `type` 与稳定身份，不复制内容，也不以晚期富化补齐；两条审阅来源缺失；历史责任未核实，辅助 related Topic 状态为假设。该零付费回执的 `modelQuality=not-measured`，不代表真实 provider 五例未测；真实 provider 结果另见本轮配对审阅。真实钉钉送达未验证。52 来源计数及哈希来自回执/投影绑定，不表述为 D 独立逐行读取生产来源。

## 协议与预算反证

D 对执行协议的只读核对发现：compact schema 不再包含原 `kind`、`sameMatter`、`replace` 语义描述，工具反馈仅给裸业务错误，关系规则没有等价字段曝光。该发现与 780/783 candidate 将实质历史回复一并 replace 的终态相符；责任层分析继续中，当前只记录反证，不将单一静态发现扩写为全链根因。

对 780/783 的私有请求体作纯内存回填核算：加入完整 summary 后分别为 51,916 B 与 51,371 B，均低于 65,536 B；原 candidate 请求体为 41,014 B 与 42,921 B。现有流程先按 12 KiB 外置 summary，再扩到 64 KiB，仍导致必读 summary 分页补读；780 的 8,511 字符 summary 实际读两页。该核算没有重新运行 Host、模型或测试，也不改写本轮已观察到的首回/补读结果。

## 五例真实模型观察数据（阶段性）

下表来自 C 汇总的私有执行证据；汇总账本为 `docs/tmp/semantic-latency/first-reply-metrics.json`，SHA256 `aa1562bf18fb9c51c26d242255409e922c243c8340609c95b32be26ff56636e1`。C 报告独立脚本逐行核对 10 个 output 的 stream/usage 与私有 group outbox/ingress 时间均通过。跨度是 ingress 首个 stage 至最后可见 stage 完成的观测跨度，不是首回；首回时长是最早 ingress `stage.startedAt` 至唯一 isolated-notification outbox `deliveredAt`，不是实际钉钉或生产延迟。input/output/cacheRead 均为各 stream usage 同名字段求和；cacheRead 缺失流数单列，不按零补齐，也不将供应商字段重解释为统一计费口径。

| 样例 | streams baseline→candidate | stage 观测跨度 ms baseline→candidate | 隔离通知首回 ms baseline→candidate | input baseline→candidate | output baseline→candidate | cacheReadTokens 已知和（缺字段流数）baseline→candidate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 773 | 8→5 | 90,212→68,203 | 90,446→68,449 | 62,178→60,871 | 1,781→1,419 | 107,520（2）→24,704（3） |
| 774 修复后复验 | 3→4 | 78,339→56,263 | 79,107→56,971 | 28,386→56,022 | 1,614→1,804 | 31,488（0）→39,424（2） |
| 778 | 6→7 | 138,673→72,843 | 138,854→73,011 | 94,655→54,740 | 3,792→2,124 | 14,464（5）→86,400（3） |
| 780 | 3→10 | 48,692→117,080 | 49,035→117,391 | 36,759→72,631 | 1,544→3,292 | 14,848（2）→188,288（3） |
| 783 | 3→11 | 49,656→164,485 | 49,919→164,803 | 37,459→80,683 | 1,635→4,323 | 14,720（2）→219,008（2） |

这些是单次样本且曝光、请求协议与纠错路径有差异，不能据此宣称普遍性能改善。773 绑定的是更早执行版本，不能套用修后 provider blob；774 首轮 source 漏账失败是独立执行对，不计入本表。780 candidate 的首包、额外读取与多次拒绝成本见上节；783 candidate 的六次拒绝也计入纠错成本。逐流 usage、首 chunk 和请求参数留在私有执行证据中，不复制原始业务内容或身份信息。

## 五例审阅与剩余边界

- 五例配对结果按维度分别判定：773 两侧共同事实归因 FAIL；774 修复后与 778 在其有界范围通过；780、783 的最终动作/授权/receipt 与回复正文正确，但 candidate 的旧回复审阅/去重选择 FAIL。不能把后续 accepted 当成历史选取正确、也不能外推一般质量或性能。
- 778 baseline/candidate 配对已由 D 独立审阅：两侧在有界输入下最终归属、原 Task、仅清单 JSON 交付授权及受理语义通过；source 与被拒绝的 Owner 输入均保全 JSON，未执行 Owner 或生产写。receipt 均非 replayed，revision 3→4 / runSequence 1→2；隔离 send/readback 1/1、empty cancel 1、Owner 尝试且拒绝 1/1、实际执行 0。两侧初态/绑定一致，通知与唯一收件人关联正确，无 error/captureError/diagnostics、历史 pending 为 0；所有请求仅含当前消息且 tool-calls 正常结束。baseline 6 流：Route 首提漏 JSON（改用 wholeMessage 后通过），Decision 首提字段/action 不支持且缺 reply，修正后通过。candidate 7 流：首次 Decision replacement incomplete，补读 `review_get` 后发现 `same_task_confirmation_missing`，补齐 sameMatter+replace 后 accepted。拒绝均 `isError=false`，仍计入纠错成本。两侧最终通过不抹初稿错误；不据 6/7 流宣称提速，也不声称完整核实 18 个示例、清单完成、Owner 完成或真实钉钉/完整生产历史。
- 778/780/783 的两侧零模型 check 已核验 scope、绑定与评测依赖一致，不是 Host/模型通过结果。780 baseline/candidate 配对已由 D 独立审阅：最终动作、授权、规范 receipt 与受理回复正文正确；但 candidate 审阅/去重选择 FAIL。baseline 仅替代 1 条旧 confirmation；candidate 将全部 4 条旧回复 replace（其中 3 条为实质结果），这些 outbox 记录均标为 `supersededByOutboundId` 指向新确认，后续候选构造会排除它们。权限核查受理不能替代之前的数据差异、表映射或同步受阻等实质结果。仅沿原 Task 追加只读结果核查，区分用户报告与独立查证，不恢复同步、不补写或声称已验收。原 Task revision 4→5 / runSequence 2→3，隔离 send/readback 1/1、empty cancel 1，Owner 执行前拒绝 1 次、实际执行 0，无生产副作用。性能路径 baseline/candidate 分别 3/10 流；candidate 少一次 Task context，但增加 route 补读 1 次、summary 两页、review 补读 1 次，并有 4 次决策拒绝。5 次 `decision_submit` 依次为：非法 reopen 字段/回复层级导致 `invalid-arguments`、`isError=true context_unread`、summary 读完两页后 `replacement_incomplete`、`review_get` 后仍 `replacement_incomplete`、最终补 `replace` 后 accepted。首包 baseline 7,818 B、candidate 41,014 B；8,511 字符 summary 仍需两页。故不据单项少读或流数宣称提速，也不因此删除完整性门禁。
- 783 baseline/candidate 配对已由 D 独立审阅：最终动作、权限授权、规范 receipt 与受理回复正文通过，但 candidate 审阅/去重选择 FAIL。baseline 仅替代 1 条旧 confirmation；candidate replace 全部 5 条旧回复（其中 4 条为实质结果），旧 outbox 均标为 `supersededByOutboundId` 指向新确认，后续候选构造将排除它们。继续账号权限核查的受理不能替代此前权限映射、差异或同步受阻等实质结果。revision 5→6 / runSequence 3→4，隔离 send/readback 1/1、empty cancel 1、Owner 尝试执行前拒绝 1 次、实际执行 0。candidate 7 次 `decision_submit` 中前 6 次拒绝依次为：reopen 多传 `progressImpact/authorizationChange` 的 `invalid-arguments`、`context_unread`（仅此为 `isError=true`）、`replacement_incomplete`、`same_task_confirmation_missing`、再次 `replacement_incomplete`、`replace_invalid`；补齐 confirmation、sameMatter 及 replace 所需五项后，第 7 次 accepted。两侧 source completed，receipt 非 replayed；通知收件人、outbox 与回读链成立，所有 3/11 个请求仅含当前消息，历史 16 个 source 的 pending 均为 0。最终结论仅涉及沿原 Task 继续账号权限/实际可用性核查，不自动改权限、不恢复同步、不将接受现状写成差异修复。拒绝均计纠错成本。总计五个有效 baseline/candidate 配对 streams 23→37；773 共同事实归因 FAIL，774 修复后与 778 有界语义通过，780/783 candidate 审阅去重 FAIL；774 原始 seed 漏账失败独立保留，不与修复后复验合并。无额外模型调用。
- 780/783 candidate 已发现错误 supersede 实质旧回复的审阅/去重退化；其他历史来源上的完整去重、附件内容、Owner 完成、真实钉钉送达及生产最终 overlay 未验证。774 的两条审阅来源缺失、778 的 18 个示例未完整核实等限制继续有效。更广泛性能差异的原因尚未收敛；本轮不据单次数据归因，也不实施性能修复。
- 本轮不写整体 `report.md`，不改 round-1 至 round-12 历史格；不执行 PR、push、部署、CI 或真实钉钉外发。
