# Topic 路由质量与首次回复优化

> 状态：ACTIVE
> Goal ID：topic-routing-quality
> 最近维护：2026-11-05T13:46:31+08:00
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
- 生产中位首回≤60秒仍是未验证目标，不能用隔离通知或进程健康代替真实钉钉送达。

## 范围与约束

- 唯一工作树D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-routing-quality。原PR #342部署源码960ddadc；本次产品9c2e623e0ffb3f69d5d33ffbb33b34cf05560755经PR #343于2026-11-05T04:55:21Z合并，merge为38f061956fcd73d8c5379fdfa6ae1367da914106，已独立回读。相同工作树现用worktree-own-source-recovery-evidence保留后续证据，不续推已合并分支。已从merged源码打双包，当前正式实例已按该合并版更新。
- 主仓main、AGENTS.md及未知bash.exe.stackdump不动。私有docs/tmp/semantic-latency不强入Git；业务、身份、完整会话、凭据不入PR或公共产物。非源码归现有docs子目录。
- Windows 11、PowerShell 7、pnpm workspace；不改全局设置、权限、PATH、执行策略或模型，不整体链接主检出node_modules。保留原五会话，不另开、clear、compact或关闭。
- 用户最新明确要求“我要你正常处理掉这十几条”：授权对当前反馈的处理中消息及其必要阻断依赖，沿既有正式恢复入口正常路由、决策和业务处理；依原始来源授权执行正常副作用。不得手改账/状态、造scope、重放ingest、放宽门禁或发送测试消息。不重复旧960ddadc部署或以重启代替修复。恢复暴露的自身回流与资源错配先最小修复、相关实跑和独立审查；必要新版本落地只走已合并源码及既有runbook，不热改安装目录、不强杀/停全实例或删订阅。不运行CI、创建发行tag或推main。
- 原五例隔离评测的凭据边界保持；本次恢复由既有Host按正式配置执行必要业务模型调用，不新增选型/付费评测矩阵，不输出或修改凭据。C唯一执行正常恢复，D只读定位及独立核终态，不重复恢复。
- 不放宽原断言、时限或门禁；短引用限当前请求，Host不补语义ID、不按标题合并、不扩大来源或授权；旧成功receipt不重判重放。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | A核心与B审阅门禁 | 完整首包、紧凑语义及审阅防退化 | A修复及D审完成，237/237、fact目标2/2；B新增类型门禁仍未实施，用户确认先部署当前版，不绕其审批 | round-14；runtime4a7a76b1、decision7b778ba4、coordinator ba9ff8d4 |
| SG2 | 分层模型与原Native超时 | 默认继承/Owner不变、原断言通过 | 原五项逐项证因5/5，相关Native57/57；仅适用各自旧冻结版本，不套后续源码 | round-10/11；round-9旧核心250/250 |
| SG3 | C真实模型对照 | 同初态、真实adapter、终态及独立语义/性能 | 原五配对已完，但语义/性能未达整体交付；history5、隔离Native3已按影响补验，不新增模型调用 | round-13/14、私有metrics aa1562bf |
| SG4 | A根因修复、C正常恢复与D独立核验 | 当前固定14条经正式处理取得真实业务终态；必要阻断依赖不扩授权 | BLOCKED待真实业务上下文：修复合并部署并独立核验通过，当前9依赖9/9正式resume后8 routed，842v1/e2空scope且无clarification；原14当前版本仍全processing、canonical完成0、completed决策覆盖0。未机械再恢复或代选材料 | round-16.md及矩阵；私有postMergedDeploymentRecovery和recovery-nine-receipts；round-15历史保留 |
| SG5 | Lead合并部署、C产物、D核验、E证据 | 合并代码、双包、原生退出、功能及独立回读 | 第15轮部署/fixture交付已完成；本次PR #343双包更新与独立安装/健康核验通过，第16轮证据保留原14条BLOCKED和测试限制，不等同业务处理完成 | PR #342/#343 MERGED；round-15历史、round-16.md、matrix.csv |

## 当前检查点

- 当前子目标：SG4
- 当前执行：本阶段收敛为BLOCKED，等待真实业务上下文。Lead已独立核当前9条CAS回执9/9 resumed，及D05:18:52.136Z阶段证据：8 routed，842v1/e2是唯一非own屏障、无scope/clarification；原14同ID/version全processing，source逐条唯一、pending14/完成0/决策覆盖0，T1 revision/processed=56/49，T2=19/4。真实Host按841/828各资源owner成功读取image，route工具有非error回执且turn结束；不是图片不可读或仅看板陈旧。C/D进一步05:22核842没有正式澄清draft/相关outbox或通知，未发问，不写等待已发问题答复。
- 唯一下一步：需真实钉钉新消息引用原“发群里”，补充具体分享内容/所指事项，或明确不是交给助手的指令；如涉及其他群，再说明目标群。现有store:843会将被引用hold转pending、绑定新上下文并重新路由，不能用本地伪造作者/draft/scope或同条件重复resume代替。真实新事实进入后再按当前version/epoch检查路由、14的decision/source及必要Task/通知终态；当前先完成证据交付，保留正常实例/监听和原团队，不声称未建立的持续后台监督或14完成。
- 已核业务终态：D05:18:52.136Z逐条核、Lead独立读私有current-processing-14.json的postMergedDeploymentRecovery，SHA256 164bf94264c08ce2bbfeb1f0354bab267b29494306178bb6e3363a2778c22d48；14同版本仍processing/source完成0，直接source关联Task/通知均0，不冒称穷尽间接matter关联。跨账采样非原子，原11:24基线保留；群processing总26不代替固定目标14。9条本次回执recovery-nine-receipts.json SHA256 48bb0bc409221110df726f11ec072e10d7d60641fb8a590d29c31fa177df92b5，与原34首次恢复分开。
- 已证资源阻断：此前833/844错用当前消息ID配引用源828/841资源ID；下载链及资源指引已修复部署，现真实Host会话中group_resource_get对841/828精确owner均isError=false且含image，route提交回执非error/turn已结束，D与Lead已独立核证据。资源已实际进入工具结果，不等同模型理解/归属及14业务完成；不再要求重发可取图片。原下载反证/273169字节与SHA保留私有，不公开身份和完整会话。
- 已证自响应/引用问题：D精确绑定806→847、849→850、850→851，三条fixed-topic-reply已送达但无原生引用；850确为插件输出又成为851来源。ACK最初只有openTaskId、精确消息身份迟于入站读取确认，后续发送许可缺复核已证；缓存/出箱的精确可见时点不可观测，不指定唯一缓存竞态。当前finalNotificationRouting显式quote:false，sourceRef只是出处，不是平台丢引用；本轮不全局改最终通知合同，不补发/修改/删除已发消息。原14不被这些回复或自身来源退役替代。B仍受原会话审批限制，不代写绕过。
- 未闭环项：原五对隔离首回均值81.4722→96.125秒、中位79.107→73.011秒、streams23→37，不能称整体提速。773双方事实误归因FAIL；774修后/778有界通过；780/783候选审阅分别错误替换3/4条实质旧结果，FAIL保留。
- 未收敛/未验：841短暂回填冲突具体分支未完全查明；下午786非法JSON/独立资源失败、788–790/817调度因果、803业务范围仍有缺口；固定摘要基线FAIL保留。真实Owner/附件内容/完整历史去重/真实钉钉及生产60秒目标未验。

## 第15轮部署与近期消息结论（历史）

双包均2.3.0：Assistant SHA256 b8066ac3…、Observer 84e11494…，完整摘要及95/4文件独立核验见validation。-Check为writes0/signals0、候选quiescent/drained true、pending0；正式CTRL+C原生退出旧PID47836、剩余后代0，新PID60180接管3080/18998。旧owner进程退出但行仍stale，不写为已清除。profile摘要不变、自启Enabled、未建备份；当前DB/初始化标记身份一致，但无部署前marker摘要基线，不宣称逐字不变。

脚本readback初始健康正常，02:03/02:05 UTC因seq841直接关联的DYNAMIC_SOURCE_CONFLICT回填退化，监听仍ready；02:10自然恢复，未重启/重放。Lead最终02:12:32.8539010Z独立GET为ok、inboundProcessing true、bridge healthy、recoveryIssueCount0，两监听ready/两回填ok。单消息mget与canonical部分投影不同，但不等同失败的range入参，无实际异常栈，不能定性抛错分支或保证不复发。

原固定20条seq814–833：基线01:19→部署后02:11:35逐ID/version/processingState对照，仍11 processing、5 needs_clarification、4 processed；仅该口径无变化。833 v2的hold epoch1→2在01:20:53部署前自然发生，不称完整投影不变。5hold均无scope/clarification；T1 revision/processed/summary=56/49/49，T2=11/4/4，无新accepted，本批通知/outbox直接关联为空。4 processed属out-of-scope处理，不是群回复送达。部署与健康恢复未解除业务等待。

原生GNU tar工具环境预检失败未停机；C交唯一执行权给Lead原生PowerShell环境，不改PATH。实际tgz首轮health通过、Task超时；后诊断Task与3执行已完成，但合成fixture未消费Host summary nextCall而循环。C仅公共fixture5行消费同request精确nextCall，D审；实际包单项原30秒/原断言1/1、business27559ms、cleanup正常。fixture0e4f8ce6/test e123bcf7前后不变，产品包不变。原失败保留，诊断轮曾改诊断投影，不能绑定单一blob。

## 团队与证据入口

A负责schema/runtime及已完成只读冲突合同核验；B唯一写coordinator，未绕其限制；C负责fact/隔离评测、5行fixture与最终去标识validation；D只读独立核，不写业务；E负责报告/matrix；Lead唯一Goal/Git/PR，并因已证工具环境差异承接本轮Native及部署执行权。五会话保留；A本次负责资源错配与自身回流的最小产品修复/相关测试/README，不触碰B唯一coordinator文件；D只读独立审查和固定14终态核验，C唯一正式业务恢复，Lead唯一Goal/Git/必要新版本整合。无新评测、模型或CI授权。

- 第15轮部署最终证据：round-15.md、round-15/validation.json及必要TAP；文档提交36ea622e已推送并独立核远端。当前业务恢复记录为round-16，E负责报告/矩阵，不覆盖旧轮、不写整体report.md。PR #342仍MERGED，收尾分支不续推#342。
- 本轮资源反证私有回执：docs/tmp/semantic-latency/host-resource-check-result.json SHA256 e33b4051…；resource-check-828-841-result.json SHA256 4a28be5c…，Lead已独立匹配冻结摘要并按精确owner/resource核原图字节。这两份早期回执仅证明实际下载链可用；后续Host真实图像曝光另见第16轮，原14业务终态仍未完成。
- 当前必要根因决策：docs/spec/own-notification-late-retirement.md，明确精确自身身份、合法退役/旧收据保留、许可与跨账恢复；不为误接纳的自身来源内部计划另赋未来执行权。原计划：docs/spec/first-reply-latency-contract.md、docs/spec/structured-routing-host-execution.md；已交付旧任务round-7/8。当前runbook为docs/ops/task-session-clean-start.md的已初始化原生双包更新，不Bootstrap。
- 历史验证：round-9核心250/下午观察；round-10五超时；round-11相关Native57；round-12旧隔离/凭据；round-13真实五对；round-14新核心237、fact2、history5、隔离3。按实际版本引用，不重复累计或将脚本模型说成真实质量。
- 私有metrics SHA256 aa1562bf18fb9c51c26d242255409e922c243c8340609c95b32be26ff56636e1。toolIsErrorCount仅isError=true，不含isError=false业务拒绝，不是网络错误数。基线recent-processing-predeploy.json SHA256 8f485479928e362d3461ef23091bb5e729a141701c7ca386b6d800850d111ab9。
- 本轮冻结Native证据：docs/acceptance/topic-routing-quality/round-16/own-late-readback-native.tap SHA256 ad000d3920e8cdaa7384d5b8b10d5fe6386f8587dadc80b318a22618c08f0710；service ceaff17b、dynamic c4d20342、store 0f2995db、native 78eff022、runtime 9299ec6f，均为测试时未提交工作树blob，随后绑定产品9c2e623e/合并38f06195，不是commit SHA；未在提交后重跑。
- 本阶段原生补验：docs/acceptance/topic-routing-quality/round-16/内release-smoke-native.tap（首12/14）、fixed-topics-native.tap（12/12）、package-native-prepacked.tap（2/2）；各原始SHA与C迟回读TAP已交E集中归round16。实际验证包SHA256 fd7debd7d9204fe59076fd715b9cbc4ff379a37778b4c029804c8b3b24a8d7ae；合并版packages/test与测试版内容相同，无新增模型调用或真实测试发信。
- 本次正式部署入口：docs/tmp/local-deploy-38f06195-evidence；原SIGINT退出60180、剩余后代0，ownerProcessExited true但ownerReleased false/staleOwner true；unknownOperations3/unknownNotifications0保持。Assistant SHA256 fd7debd7d9204fe59076fd715b9cbc4ff379a37778b4c029804c8b3b24a8d7ae，Observer完整SHA同第15轮。该部署成功不刷新原14业务终态。
