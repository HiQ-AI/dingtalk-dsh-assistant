# Topic 路由质量与首次回复优化

> 状态：ACTIVE
> Goal ID：topic-routing-quality
> 最近维护：2026-11-05T15:32:28+08:00
> 权威目标：D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-routing-quality/docs/acceptance/topic-routing-quality/goal.md

## 总目标

原事项召回、持久待判、语义评估及合同清理已通过PR #337合并部署，见round-8，不重做。本轮优化收到消息至首次回复：精简结构提交、前置必要Task及审阅、解除普通决策全量摘要重写阻塞。保留两级分诊与Task Owner，不提前发送泛泛“收到”冒充改善。

并入2026-11-04下午固定批次异常分析、两级结构化业务意图及独立模型配置。Task创建/唤醒/取消/中断、发送及送达回读继续由Host执行，保留必要检索补读及Owner工具。topicRouteModel/topicDecisionModel默认null继承原模型，未修改正式选型，不按显示名推断模型性能。

## 完成条件

- 结构化协议与必要上下文优化完成，来源、授权、版本、实际曝光、审阅、幂等及恢复反例保持；真实审阅不退化。
- 固定下午批次分层核对，已证根因在授权内处理，未收敛项明确，不把accepted当完成。
- 原五例隔离真实Host/provider对照及D独立语义审完成，记录首回终态、流、调用、token及性能；不以脚本模型替代。
- 用户2026-11-05重复明确先本机部署：基于已合并代码按runbook双包切换并独立回读，再只读检查最近固定20条卡点。此项本轮已完成，不等于整体性能与审阅目标完成。
- 用户追加要求正常处理固定14条及其必要路由依赖：逐条取得覆盖当前版本的决策与canonical source完成终态，必要Task/通知按原始授权完成；不得只清看板状态或以恢复回执代替完成。
- 用户2026-11-05新增规则：不明确输入应归“职责外话题”或由Host真实引用原消息主动询问，不能仅持久化无问句/无法发送的待判并阻塞其他Topic；真正问询后的回复须按精确送达ID回链恢复原来源。语义职责外缺省如实记录为程序策略，不吞版本/资源/权限/持久化错误，不覆盖已有单位及历史效果。
- 生产中位首回≤60秒仍是未验证目标，不能用隔离通知或进程健康代替真实钉钉送达。

## 范围与约束

- 唯一工作树D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-routing-quality。原PR #342部署源码960ddadc；本次产品9c2e623e0ffb3f69d5d33ffbb33b34cf05560755经PR #343于2026-11-05T04:55:21Z合并，merge为38f061956fcd73d8c5379fdfa6ae1367da914106，已独立回读。相同工作树现用worktree-own-source-recovery-evidence保留后续证据，不续推已合并分支。已从merged源码打双包，当前正式实例已按该合并版更新。
- 主仓main、AGENTS.md及未知bash.exe.stackdump不动。私有docs/tmp/semantic-latency不强入Git；业务、身份、完整会话、凭据不入PR或公共产物。非源码归现有docs子目录。
- Windows 11、PowerShell 7、pnpm workspace；不改全局设置、权限、PATH、执行策略或模型，不整体链接主检出node_modules。保留原五会话，不另开、clear、compact或关闭。
- 用户最新明确要求“我要你正常处理掉这十几条”：授权对当前反馈的处理中消息及其必要阻断依赖，沿既有正式恢复入口正常路由、决策和业务处理；依原始来源授权执行正常副作用。不得手改账/状态、造scope、重放ingest、放宽门禁或发送测试消息。不重复旧960ddadc部署或以重启代替修复。恢复暴露的自身回流与资源错配先最小修复、相关实跑和独立审查；必要新版本落地只走已合并源码及既有runbook，不热改安装目录、不强杀/停全实例或删订阅。不运行CI、创建发行tag或推main。
- 原五例隔离评测的凭据边界保持；本次恢复由既有Host按正式配置执行必要业务模型调用，不新增选型/付费评测矩阵，不输出或修改凭据。C唯一执行正常恢复，D只读定位及独立核终态，不重复恢复。
- 最新规则允许Host按管理员分诊策略发澄清问句；发问许可与Task执行授权分开，不虚填agentDirected，不凭询问/答复自动授予Task副作用权限。原来源/作者/版本/审阅与自身通知围栏保持。
- 不放宽原断言、时限或业务执行门禁；短引用限当前请求，Host不补语义ID、不按标题合并、不扩大来源或授权；旧成功receipt不重判重放。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | A核心与B审阅门禁 | 完整首包、紧凑语义及审阅防退化 | A修复及D审完成，237/237、fact目标2/2；B新增类型门禁仍未实施，用户确认先部署当前版，不绕其审批 | round-14；runtime4a7a76b1、decision7b778ba4、coordinator ba9ff8d4 |
| SG2 | 分层模型与原Native超时 | 默认继承/Owner不变、原断言通过 | 原五项逐项证因5/5，相关Native57/57；仅适用各自旧冻结版本，不套后续源码 | round-10/11；round-9旧核心250/250 |
| SG3 | C真实模型对照 | 同初态、真实adapter、终态及独立语义/性能 | 原五配对已完，但语义/性能未达整体交付；history5、隔离Native3已按影响补验，不新增模型调用 | round-13/14、私有metrics aa1562bf |
| SG4 | A根因修复、C正常恢复与D独立核验 | 当前固定14条经正式处理取得真实业务终态；必要阻断依赖不扩授权 | DONE：原14同版本canonical各唯一、来源完成14/pending0/完成决策覆盖14；842既有静默纠正另计。T1当前req4/control4/lease80完成并排空，input9成功且原分析产物3份经D核验，完成fact对应回复delivered/attempt1；T2当前req1完成并排空，真实用户确认依据及完成fact静默投影已核，不冒认助手修复 | 私有postCorrectionBusiness.finalReadback/D06:56:22.495Z；SHA256 4c7a31c1；第17轮待阶段末集中归档 |
| SG5 | Lead合并部署、C产物、D核验、E证据 | 合并代码、双包、原生退出、功能及独立回读 | 第15轮部署/fixture交付已完成；本次PR #343双包更新与独立安装/健康核验通过，第16轮证据保留原14条BLOCKED和测试限制，不等同业务处理完成 | PR #342/#343 MERGED；round-15历史、round-16.md、matrix.csv |
| SG6 | A不明确输入分流、C隔离联调、D独立审查 | 职责外或真实发问闭环；合法scope仅阻断相关Topic；问句精确回链；旧units/效果及错误边界保持 | IN_PROGRESS：实现与冻结本地验证完成；runtime210/210、store定向2/2、当前原生13/13、实际包smoke14/14；待PR、合并与本机部署，不等同真实新消息验收 | runtime3dde2dc1/store6ece9dfc/serviceb55ed35c；Native测试ed518cdc；候选Assistant eef7295f；第18轮阶段末集中归档 |

## 当前检查点

- 当前子目标：SG6
- 当前执行：SG4已独立核完并形成第17轮；SG6六模块及README已冻结，D增量及Native夹具审查已收束，当前原生13/13、runtime210/210、store定向2/2均通过；Lead对本次候选实际包使用既有预打包入口完整release-smoke14/14、0失败/跳过，原断言/时限。候选Assistant SHA256 eef7295ff7219f8f461f2577c37d36adc4ad0495728d0f2f90d9e6e89345c33e，Observer84e11494不变；正式实例仍38f06195，尚未安装新包。
- 唯一下一步：接回D最终冻结结论后提交并回读新PR，按既有授权合并后核源码/包一致，沿runbook先-Check再排空双包切换及独立回读；从打包至安装核验保持包源码冻结。E集中收口第17轮业务结果及旧附件，第18轮在新规则验证/部署阶段结束后集中归档。C原SG4三观察均已接回，无须重复等待或wake；不造正式测试消息、不手动触发CI或新模型评测。长期Goal仍ACTIVE。
- SG6验证边界：Native为真实隔离Host/脚本provider与隔离发送适配器，不是真实钉钉或模型语义质量验收；Service恶意proof/错误作者/未送达引用的独立Native负例尚未实跑，store层身份/送达ID/版本/epoch/outbox反例及静态接线已覆盖。组合回归455/456保留既有摘要“第一版”对空串失败，组合启动未捕获最终指纹，仅作诊断；最终定向验证分别绑定实际冻结blob，不据此称全仓全绿。
- SG4最终独立回读：D于2026-11-05T06:56:22.495Z核原14同基线版本、canonical各唯一、sourceCompleted14/pending0/completedDecisionCovered14，两Task均当前版本completed/drained，pending人类请求0。T1 req4/control4/lease80 input9执行成功且Owner已真实读取结果，3份分析产物符合仅分析不修改/部署要求；本次completed fact已accepted/projected，原同群回复06:54:13.028Z delivered/attempt1、精确receipt且覆盖该fact。T2 req1由真实用户确认收口，完成fact正式静默审阅，不冒认助手修复。T1保留一条回合中到达的execution.result pending wake，终态Task不再调度，不能写全wake acked或人工清账。Lead独立核私有current-processing-14.json/postCorrectionBusiness.finalReadback，整文件SHA256 4c7a31c1547d6f51901c90f19d4610233ee17a4a409c1d82f20d1ec53430aab4；跨账非原子采样、businessFinalVerified仅限固定14和必要两Task，不代表新规则或整体性能完成。
- 已核必要依赖：842根据用户真实闲聊反馈沿既有fixed-topic out-of-scope correction静默处理，routingRevision779→780、closedTopic0；Resident routed、canonical于06:06:54.941Z自然recover完成，无新Task/通知/outbox，历史hold字段不再生效。该处置不依赖新产品或发版；C随后对当前2个配置群一次普查，现存needs_clarification均0，本轮无需全库历史迁移/重放。证据复用私有recovery-nine-receipts.json/currentHoldCensus，最近核摘要702feb06b300296853f02d201599cce53540378e0dd25efeea3f42a959ba6c6b。
- 过程检查点（历史，D读取06:17:34.120Z）：T2当前reqRev1/control1/lease2于06:14:04.967Z产生权威completion，submit complete已accepted、Owner结束并drained，创建/补充wake已ack，无人工待答；无execution是Owner直接完成，不是未启动，不扩大为结果内容已验。T1当前reqRev4/control4匹配，Owner已成功委派inputVersion9实际执行，submit wait已accepted、Owner drained/lastDecision wait且reopen wake已ack，是合法等待执行；早先8次read错误已被后续真实读取/委派取代，不当当前阻断。两原通知C按精确主键回读均delivered/attempt1，最终通知仍按本次实际需要核验。
- 过程来源/决策检查点（历史）：D06:08:51.297Z逐条核，Lead独立读取现有私有current-processing-14.json/postCorrectionBusiness：14同基线version、canonical各唯一，sourceCompleted14/sourcePending0/completedDecisionCovered14；businessFinalVerified=false。T1 decision56/processed56、reopen applied；T2 decision19/processed19、new-task applied，新源导致的Topic20单列不混原14。两Task均active/drainedfalse且无当前completion，T2回复已delivered/attempt1、T1发送尚待终态（该时点）。correction842回执复用recovery-nine-receipts.json，已核SHA256 27192a13cb2cec08e1f2f123ca37c259661237ba4eecd714cbac2dce2e57e96b。
- 上一阶段已核业务终态（本次执行前历史）：D05:18:52.136Z逐条核、Lead独立读私有current-processing-14.json的postMergedDeploymentRecovery，SHA256 164bf94264c08ce2bbfeb1f0354bab267b29494306178bb6e3363a2778c22d48；14同版本仍processing/source完成0，直接source关联Task/通知均0，不冒称穷尽间接matter关联。跨账采样非原子，原11:24基线保留；群processing总26不代替固定目标14。9条本次回执recovery-nine-receipts.json SHA256 48bb0bc409221110df726f11ec072e10d7d60641fb8a590d29c31fa177df92b5，与原34首次恢复分开。
- 已证资源阻断：此前833/844错用当前消息ID配引用源828/841资源ID；下载链及资源指引已修复部署，现真实Host会话中group_resource_get对841/828精确owner均isError=false且含image，route提交回执非error/turn已结束，D与Lead已独立核证据。资源已实际进入工具结果，不等同模型理解/归属及14业务完成；不再要求重发可取图片。原下载反证/273169字节与SHA保留私有，不公开身份和完整会话。
- 已证自响应/引用问题：D精确绑定806→847、849→850、850→851，三条fixed-topic-reply已送达但无原生引用；850确为插件输出又成为851来源。ACK最初只有openTaskId、精确消息身份迟于入站读取确认，后续发送许可缺复核已证；缓存/出箱的精确可见时点不可观测，不指定唯一缓存竞态。当前finalNotificationRouting显式quote:false，sourceRef只是出处，不是平台丢引用；本轮不全局改最终通知合同，不补发/修改/删除已发消息。原14不被这些回复或自身来源退役替代。B仍受原会话审批限制，不代写绕过。
- 未闭环项：原五对隔离首回均值81.4722→96.125秒、中位79.107→73.011秒、streams23→37，不能称整体提速。773双方事实误归因FAIL；774修后/778有界通过；780/783候选审阅分别错误替换3/4条实质旧结果，FAIL保留。
- 未收敛/未验：841短暂回填冲突具体分支未完全查明；下午786非法JSON/独立资源失败、788–790/817调度因果、803业务范围仍有缺口；固定摘要基线FAIL保留。原五例及整体质量层面的真实Owner/附件内容/完整历史去重、真实新消息及生产60秒目标未验，不覆盖已完成SG4的当前Task/通知核验。

## 第15轮部署与近期消息结论（历史）

双包均2.3.0：Assistant SHA256 b8066ac3…、Observer 84e11494…，完整摘要及95/4文件独立核验见validation。-Check为writes0/signals0、候选quiescent/drained true、pending0；正式CTRL+C原生退出旧PID47836、剩余后代0，新PID60180接管3080/18998。旧owner进程退出但行仍stale，不写为已清除。profile摘要不变、自启Enabled、未建备份；当前DB/初始化标记身份一致，但无部署前marker摘要基线，不宣称逐字不变。

脚本readback初始健康正常，02:03/02:05 UTC因seq841直接关联的DYNAMIC_SOURCE_CONFLICT回填退化，监听仍ready；02:10自然恢复，未重启/重放。Lead最终02:12:32.8539010Z独立GET为ok、inboundProcessing true、bridge healthy、recoveryIssueCount0，两监听ready/两回填ok。单消息mget与canonical部分投影不同，但不等同失败的range入参，无实际异常栈，不能定性抛错分支或保证不复发。

原固定20条seq814–833：基线01:19→部署后02:11:35逐ID/version/processingState对照，仍11 processing、5 needs_clarification、4 processed；仅该口径无变化。833 v2的hold epoch1→2在01:20:53部署前自然发生，不称完整投影不变。5hold均无scope/clarification；T1 revision/processed/summary=56/49/49，T2=11/4/4，无新accepted，本批通知/outbox直接关联为空。4 processed属out-of-scope处理，不是群回复送达。部署与健康恢复未解除业务等待。

原生GNU tar工具环境预检失败未停机；C交唯一执行权给Lead原生PowerShell环境，不改PATH。实际tgz首轮health通过、Task超时；后诊断Task与3执行已完成，但合成fixture未消费Host summary nextCall而循环。C仅公共fixture5行消费同request精确nextCall，D审；实际包单项原30秒/原断言1/1、business27559ms、cleanup正常。fixture0e4f8ce6/test e123bcf7前后不变，产品包不变。原失败保留，诊断轮曾改诊断投影，不能绑定单一blob。

## 团队与证据入口

A负责schema/runtime及已完成只读冲突合同核验；B唯一写coordinator，未绕其限制；C负责fact/隔离评测、5行fixture与最终去标识validation；D只读独立核，不写业务；E负责报告/matrix；Lead唯一Goal/Git/PR，并因已证工具环境差异承接本轮Native及部署执行权。五会话保留；A本次负责资源错配与自身回流的最小产品修复/相关测试/README，不触碰B唯一coordinator文件；D只读独立审查和固定14终态核验，C唯一正式业务恢复，Lead唯一Goal/Git/必要新版本整合。无新评测、模型或CI授权。

- 第15轮部署最终证据：round-15.md、round-15/validation.json及必要TAP；文档提交36ea622e已推送并独立核远端。第16轮为历史BLOCKED阶段；当前业务恢复与新规则验证记第17轮，E负责报告/矩阵，不覆盖旧轮、不写整体report.md。PR #342仍MERGED，收尾分支不续推#342。
- 本轮资源反证私有回执：docs/tmp/semantic-latency/host-resource-check-result.json SHA256 e33b4051…；resource-check-828-841-result.json SHA256 4a28be5c…，Lead已独立匹配冻结摘要并按精确owner/resource核原图字节。这两份早期回执仅证明实际下载链可用；后续Host真实图像曝光另见第16轮，原14业务终态仍未完成。
- 当前必要根因决策：docs/spec/own-notification-late-retirement.md，明确精确自身身份、合法退役/旧收据保留、许可与跨账恢复；不为误接纳的自身来源内部计划另赋未来执行权。原计划：docs/spec/first-reply-latency-contract.md、docs/spec/structured-routing-host-execution.md；已交付旧任务round-7/8。当前runbook为docs/ops/task-session-clean-start.md的已初始化原生双包更新，不Bootstrap。
- 历史验证：round-9核心250/下午观察；round-10五超时；round-11相关Native57；round-12旧隔离/凭据；round-13真实五对；round-14新核心237、fact2、history5、隔离3。按实际版本引用，不重复累计或将脚本模型说成真实质量。
- 私有metrics SHA256 aa1562bf18fb9c51c26d242255409e922c243c8340609c95b32be26ff56636e1。toolIsErrorCount仅isError=true，不含isError=false业务拒绝，不是网络错误数。基线recent-processing-predeploy.json SHA256 8f485479928e362d3461ef23091bb5e729a141701c7ca386b6d800850d111ab9。
- 本轮冻结Native证据：docs/acceptance/topic-routing-quality/round-16/own-late-readback-native.tap SHA256 ad000d3920e8cdaa7384d5b8b10d5fe6386f8587dadc80b318a22618c08f0710；service ceaff17b、dynamic c4d20342、store 0f2995db、native 78eff022、runtime 9299ec6f，均为测试时未提交工作树blob，随后绑定产品9c2e623e/合并38f06195，不是commit SHA；未在提交后重跑。
- 本阶段原生补验：docs/acceptance/topic-routing-quality/round-16/内release-smoke-native.tap（首12/14）、fixed-topics-native.tap（12/12）、package-native-prepacked.tap（2/2）；各原始SHA与C迟回读TAP已交E集中归round16。实际验证包SHA256 fd7debd7d9204fe59076fd715b9cbc4ff379a37778b4c029804c8b3b24a8d7ae；合并版packages/test与测试版内容相同，无新增模型调用或真实测试发信。
- 本次正式部署入口：docs/tmp/local-deploy-38f06195-evidence；原SIGINT退出60180、剩余后代0，ownerProcessExited true但ownerReleased false/staleOwner true；unknownOperations3/unknownNotifications0保持。Assistant SHA256 fd7debd7d9204fe59076fd715b9cbc4ff379a37778b4c029804c8b3b24a8d7ae，Observer完整SHA同第15轮。该部署成功不刷新原14业务终态。
