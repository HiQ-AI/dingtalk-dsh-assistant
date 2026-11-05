# Topic 路由质量与首次回复优化

> 状态：ACTIVE
> Goal ID：topic-routing-quality
> 最近维护：2026-11-05T09:26:59+08:00
> 权威目标：D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-routing-quality/docs/acceptance/topic-routing-quality/goal.md

## 总目标

原事项召回、持久待判、语义评估及合同清理已通过PR #337合并并本地部署，历史交付见round-8，不重做、不再推已合并分支。本轮按用户“可以，team开始实施吧”优化收到消息至首次回复：精简结构提交、前置必要完整Task与审阅资料、解除普通决策全量摘要重写阻塞、减少重复协议和补读。保留两级分诊与Task Owner，不提前发送泛泛“收到”冒充改善。

并入2026-11-04下午14:00后固定批次异常分析：两级模型只提交结构化业务意图，Task创建/唤醒/取消/中断、消息发送及送达回读由既有Host执行；保留必要检索/补读，不退役Owner工具。新增topicRouteModel/topicDecisionModel，默认null完整继承原模型、Owner不变；不按Sol/Terra/Luna显示名推断性能，不修改正式选型。

## 完成条件

- 固定结构协议及必要上下文优化完成，来源、授权、版本、实际曝光、审阅、幂等及恢复反例保持；真实审阅不退化。
- 固定下午批次与直接关联链分层核对，授权内已证根因修复并验证；未收敛项明确，不把accepted当业务完成。
- 原五例既有provider/model的隔离真实Host对照及D独立语义审完成，记录首次回复终态、完整流、调用、token与性能；性能未改善继续定位，不以脚本模型替代。
- 用户2026-11-05明确追加“先部署本地”：按本地runbook在相关验证、提交/PR与合并后部署本机，不等待普遍性能收益证明；保留真实性能失败，禁止CI、真实钉钉测试及业务重放。随后只读检查最近固定批次的消息卡点，明确所处处理阶段与证据。
- 生产中位首回≤60秒仅为待部署/自然流量验证目标，不能用隔离通知代替真实钉钉送达。

## 范围与约束

- 唯一工作树D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-routing-quality，分支worktree-first-reply-latency。HEAD b2bc4070已整合origin/main=93e431a2（#341）；本轮产品仍有未提交团队改动，结论绑定实际内容版本，不只HEAD。最近fetch主干未变，最终交付前再核必要变化。
- 主仓main及AGENTS.md/原未跟踪文件不动。未知bash.exe.stackdump保留，不删除不提交；docs/tmp/first-reply-pr-body.md为草稿，私有docs/tmp/semantic-latency已忽略，不强加进Git。
- Windows 11、PowerShell 7；依赖pnpm install --frozen-lockfile，不整体链接主检出node_modules。五原会话保留，不另开、clear、compact或关闭，不修改模型/权限/settings/PATH/执行策略。
- 正式业务数据只读取证，不手改账/重放/真实钉钉测试发信；本轮新增授权仅允许按runbook安装双包与原生排空重启，不强停活动业务、不扩大为恢复旧动作。无跨仓修改/敏感外发/扩付费矩阵，当前优先部署必要本地验证，不新增模型调用。
- 用户已明确允许只读使用当前实例既有模型凭据，仅原五例隔离子进程临时认证，不输出、不落盘、不进argv/日志、不改正式凭据/配置。官方解析器可必要整文档内存校验后只取目标ref，不探查其他引用、不加载正式可写凭据服务。C执行、D审；错误回显在Host前/证据前/父stdout前脱敏。
- 不降低原业务断言、时限或门禁。短引用仅本请求，Host规范展开，不自动选择来源/同事项/替换ID，不按标题合并，不扩授权。旧成功receipt/操作账不重判重放。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | A核心、B协调门禁：结构化合同及性能反证修复 | 真实完整首包、紧凑语义不丢失、审阅防退化 | A修复已完成且D复审；237/237及事实目标2/2已回传。B类型门禁待审批/实施，用户明确先部署当前已验证版，缺口保留，不换人绕过 | runtime4a7a76b1、decision7b778ba4、runtime test7e8b32bd、fact test6d875550；待最终联合验证 |
| SG2 | 决策视图、分层模型、原Native超时 | 默认继承/Owner不变，原断言和生命周期通过 | 原五项超时已逐项证因5/5；相关Native57/57完成。后续源码变更按影响验证，不自动沿用旧版本结论 | round-10、round-11；核心旧冻结版250/250见round-9 |
| SG3 | C：原五例真实Host/模型 | 同初态、真实adapter、规范receipt及独立语义/性能 | 原五配对结束；当前history5/5、Native隔离3/3通过，9项blob前后一致，仅绑定门禁前coordinator ba9ff8d4；首跑profile准备失败保留。无在途Host/模型，当前不新增付费，用户确认先本机部署 | round-13与私有metrics aa1562bf；修后另轮 |
| SG4 | D：独立源码/事实/持久终态反证 | 不把工具接纳当语义正确，审最小修复 | 原五例审完；A摘要状态残留/fact吞错两项修复已静态闭合，B门禁仍待审 | D已独立核A/C实际blob；不代跑不写源码/测试 |
| SG5 | E文档、Lead Git合并、C本机部署 | 真实源码与双包、原生排空及功能独立回读 | 第13轮Lead已读，待E最后精确措辞与冻结回执；测试映射唯一3导入增量已更新并check343/历史3/删除0通过；后续修复另轮；无新commit/push/PR | round-13、matrix、既有PR草稿；Goal仅Lead单写 |

## 当前检查点

- 当前子目标：SG1
- 唯一下一步：用户在已知门禁未完成与风险后再次明确“部署本地”，按其决定先提交/PR/合并当前已验证源码，C按原生runbook双包pack、必要smoke、同参数-Check与真实排空切换；D/Lead独立核包SHA256、安装版本、新PID、健康及相关功能。B新增门禁和修后模型复验不再作为本次部署前提，不代改B或绕审批；部署脚本硬检查仍全部遵守。随后D只读核固定近期20条卡点，不重放/唤醒/改账。
- 已证阻断：B会话只读规划/审批只限制该新增门禁实施，本次用户确认先部署当前版，相关产品缺口保留，不能宣称已修。完整部署-Check尚待精确合并SHA与冻结双包；活动业务/原生回合是否排空由脚本和D只读事实确认，不据processing投影直接认定，不强停或跳校验。当前无在途Host/模型。
- 未闭环项：原五例平均隔离首回81.4722→96.125秒，中位79.107→73.011秒，streams23→37，不能称总体提速。773双方事实误归因FAIL；774修后/778有界通过；780/783动作/权限/正文正确，但candidate分别错误supersede3/4条实质历史结果，审阅FAIL。
- 未收敛/未验：下午786非法JSON与独立资源失败、788–790/817精确调度因果、803业务范围仍有证据缺口；固定摘要基线FAIL保留。真实Owner/附件内容/完整历史去重/正式最终overlay/真实钉钉与生产60秒目标未验。当前尚未合并或部署，无业务写/CI。

## 已确认的修复决定

- 比较初态/版本错配、纯模型不遵循、产品合同/装配缺口三路：同初态/check/Task深相等排除首路；非法strict字段及忽略明示指针含模型不遵循，但compact实际schema丢失原审阅字段语义、先12KiB外置后64KiB装配的冗余补读均有直接证据。
- A让compact/full复用审阅字段说明；在最终真实UTF-8 body预算内恢复完整summary并同步实际可见门禁，超限仍完整分页。780/783原体回填后51916/51371B，均低于65536B。基础/补读仍12KiB，不截断合同、不强制全Task/全历史。
- D检出新inlineSummary同轮残留及fact preflight布尔合同吞context-required两项，A已修：每次重建先清状态；fact保留throw附contextRequired，由工具catch返可操作nextCall，不消费请求/事实。原账本合同与直接异常不变。237含定向5项，不加成242；事实2项是否重叠按实际命令收口，不直接累加。
- 审阅类型规则由A/D比较仅恢复说明、仅改善反馈、类型fail-closed后确定：新confirmation仅替换持久replyKind=confirmation；substantive/correction/未知均不可被受理确认覆盖。显式correction原合同保留，不自动改kind/ID/业务归属，旧receipt/outbox/recovery不重审。A负责schema/runtime，B唯一写coordinator，C唯一写本轮fact测试，D只读审，E同步README。

## 本机部署与近期消息诊断

C已只读核3080/18998同PID47836（2026-11-04 16:40:25启动）、自启Running/Enabled、health ok/recoveryIssueCount0，profile SHA256 1f2c3b27f47d2635c5c02c22c5965ec6c1d12b3516c86d77de7a8a4813e59f55，D盘约19.65GB。maintenance为workflow_maintenance_unavailable，必须走docs/ops/task-session-clean-start.md已初始化实例原生双包流程，不能Bootstrap。完整-Check仍待已合并冻结源码/双包与哈希，不据健康或一次快照声称静止。切换前基线已固定同群seq814–833共20条，观测2026-11-05T01:19:00.242Z：processing11、needs_clarification5、processed4；此状态不证明活跃或根因。私有去正文基线recent-processing-predeploy.json SHA256 8f485479928e362d3461ef23091bb5e729a141701c7ca386b6d800850d111ab9，Lead已独立匹配。D唯一按该批定点诊断source→route→decision→Task/Owner→notification，C不并行读生产；不强停或清队列，部署后只读复核同批，不自行retry/replay/wake/cancel。

## 有界实验与历史边界

- 原五例773/774/778/780/783，固定cortex-gateway/cortex-cowork/low、统一web profile/provider模块/harness，产品按各侧source加载；773早于修后runner，不套最新blob。每侧单次有效样本，774初轮漏canonical source/admission失败独立保留，不计有效配对。
- 773/774辅助关联Topic旧status不可证：strict helper仍拒绝，仅显式benchmark统一设active；缺审阅来源3/2条，不称精确历史或完整去重。Task completed/drained、原文、授权和期望动作不改。资源只投影type+稳定ID，不复制晚期富化、不重建内容；来源52/6/15/16按各例实证恢复，不重放旧ingest或造历史完成账。
- Host终态为规范动作接纳与隔离通知receipt，不是Owner完成；空cancel符合真实空注册表无效果语义。有动作可调度run，但stub必须执行前拒绝，实际Owner=0；actions=[]仍要求run尝试0，按Host close后分项计数，不暂停正常调度凑数。
- 原offline非法revision、过严cancel及零尝试判据false均保留；最终terminalValid=true是新增零付费实跑，非改判旧失败。凭据解析旧false与实际true也分开保留。
- 773双方虽误归因，但完整引用与已有多修复核对指引均实际曝光，尚无已证产品合同缺口；不猜测加prompt或事实平台。下午批次固定为2026-11-04 14:00至G1 seq817 receivedAt17:41:26.915，32消息/34来源版本，不滚动扩扫。

## 团队执行边界

A/routing-core负责schema/runtime及相关纯合同测试；B/routing-recall仅其coordinator门禁与对应纯合同测试，保留原宿主禁止重启限制；C/routing-eval负责fact测试、唯一Native/Host/模型执行权和私有证据；D/routing-review只读独立审，不写不跑；E/routing-docs负责README、轮次与matrix。Lead只统筹、关键核验、唯一Goal、PR草稿和最终Git交付。成员直接沟通，不需Lead转发普通依赖，不改窗口/权限、不绕过实际拒绝。未知改动保护，明确单写交接不当作未知外来修改。

## 证据入口

- 前置合同：docs/spec/first-reply-latency-contract.md、docs/spec/structured-routing-host-execution.md；原已完成任务见round-7/8及PR #337。
- 核心冻结旧版与下午观察：round-9.md及routing-core-unit版本清单；五项超时诊断round-10.md；Native57项round-11.md；旧隔离5项/凭据预检round-12.md。已绿无关部分不重复。 当前history5/隔离Native3已由C补验，不再套round-12旧版本；真实web profile为D:/dsh_home/profiles/web/package.json，误设工作树profile的prepare失败不计业务结果。
- 原五例真实观察与初态修复：round-13.md及matrix.csv；后续修复复验另轮，不覆盖失败、不写整体report.md冒充全绿。
- 私有指标docs/tmp/semantic-latency/first-reply-metrics.json，最新SHA256 aa1562bf18fb9c51c26d242255409e922c243c8340609c95b32be26ff56636e1，Lead已独立匹配并读数；toolIsErrorCount仅工具isError，不等同网络错误，未含isError=false业务拒绝。原始流/业务/身份/凭据不入Git或公共产物。
- Git交付：当前无本轮最终commit/push/新PR；旧#337已合并不得续推。最终核目标主干、源码版本与相关验证，push前查PR state；PR正文同一UTF-8文件过门禁后gh写入并独立回读，不触发CI。用户已新增本机部署授权，按runbook合并后部署，不能本地未合并构建直接替换。
