# Topic 路由质量与首次回复优化

> 状态：ACTIVE
> Goal ID：topic-routing-quality
> 最近维护：2026-11-05T10:39:25+08:00
> 权威目标：D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-routing-quality/docs/acceptance/topic-routing-quality/goal.md

## 总目标

原事项召回、持久待判、语义评估及合同清理已通过PR #337合并部署，见round-8，不重做。本轮优化收到消息至首次回复：精简结构提交、前置必要Task及审阅、解除普通决策全量摘要重写阻塞。保留两级分诊与Task Owner，不提前发送泛泛“收到”冒充改善。

并入2026-11-04下午固定批次异常分析、两级结构化业务意图及独立模型配置。Task创建/唤醒/取消/中断、发送及送达回读继续由Host执行，保留必要检索补读及Owner工具。topicRouteModel/topicDecisionModel默认null继承原模型，未修改正式选型，不按显示名推断模型性能。

## 完成条件

- 结构化协议与必要上下文优化完成，来源、授权、版本、实际曝光、审阅、幂等及恢复反例保持；真实审阅不退化。
- 固定下午批次分层核对，已证根因在授权内处理，未收敛项明确，不把accepted当完成。
- 原五例隔离真实Host/provider对照及D独立语义审完成，记录首回终态、流、调用、token及性能；不以脚本模型替代。
- 用户2026-11-05重复明确先本机部署：基于已合并代码按runbook双包切换并独立回读，再只读检查最近固定20条卡点。此项本轮已完成，不等于整体性能与审阅目标完成。
- 生产中位首回≤60秒仍是未验证目标，不能用隔离通知或进程健康代替真实钉钉送达。

## 范围与约束

- 唯一工作树D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-routing-quality。产品提交4a2282f7，PR #342于2026-11-05T01:36:52Z合并，部署源码960ddadc1aae64877355a344aa36cf8aa6f410b8；最后fetch主干未变。收尾分支worktree-first-reply-deployment，仅5行公共测试fixture与文档证据，部署包源码不变，不续推已合并分支。
- 主仓main、AGENTS.md及未知bash.exe.stackdump不动。私有docs/tmp/semantic-latency不强入Git；业务、身份、完整会话、凭据不入PR或公共产物。非源码归现有docs子目录。
- Windows 11、PowerShell 7、pnpm workspace；不改全局设置、权限、PATH、执行策略或模型，不整体链接主检出node_modules。保留原五会话，不另开、clear、compact或关闭。
- 正式业务只读取证，不改账/重放/真实测试发信。部署授权覆盖原生排空、双包安装与计划任务启动，未扩为旧业务恢复、清hold或绕过活动检查。未运行CI、创建发行tag或推main。
- 原五例既有凭据仅原隔离子进程临时认证，用户已明确允许；不输出/落盘/进argv，不探查其他ref，不扩大模型调用。当前无在途Host、模型或部署任务。
- 不放宽原断言、时限或门禁；短引用限当前请求，Host不补语义ID、不按标题合并、不扩大来源或授权；旧成功receipt不重判重放。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | A核心与B审阅门禁 | 完整首包、紧凑语义及审阅防退化 | A修复及D审完成，237/237、fact目标2/2；B新增类型门禁仍未实施，用户确认先部署当前版，不绕其审批 | round-14；runtime4a7a76b1、decision7b778ba4、coordinator ba9ff8d4 |
| SG2 | 分层模型与原Native超时 | 默认继承/Owner不变、原断言通过 | 原五项逐项证因5/5，相关Native57/57；仅适用各自旧冻结版本，不套后续源码 | round-10/11；round-9旧核心250/250 |
| SG3 | C真实模型对照 | 同初态、真实adapter、终态及独立语义/性能 | 原五配对已完，但语义/性能未达整体交付；history5、隔离Native3已按影响补验，不新增模型调用 | round-13/14、私有metrics aa1562bf |
| SG4 | D独立审与近期诊断 | 反证、持久终态及业务阶段明确 | A两修复及fixture5行已审；本机双包/运行态/配置/持久身份和固定20条部署后只读对照完成 | round-15/validation.json |
| SG5 | Lead合并部署、C产物、D核验、E证据 | 合并代码、双包、原生退出、功能及独立回读 | 本轮部署、近期诊断及证据整理完成；暂态入站失败历史与未恢复的业务等待保留。5行fixture已在296a5f18提交，文档及证据由收尾提交绑定 | PR #342 MERGED；round-15.md、round-15/validation.json、matrix.csv |

## 当前检查点

- 当前子目标：SG5
- 唯一下一步：等待用户明确后续处理范围与授权，不自动恢复5条待判、重放旧消息、实施B门禁或开启付费模型复验。本轮部署及近期诊断已完成，Git收尾状态以当前分支独立回读为准；长期目标保持ACTIVE，不能把本轮部署完成写成性能目标完成。
- 已证阻断：5条未知范围hold仍阻断11条Topic决策，需要真实补充及有权限人员明确归属/范围；本轮只读诊断，不清安全屏障。B新增confirmation替换类型门禁仍受原会话审批限制，不代写绕过。
- 未闭环项：原五对隔离首回均值81.4722→96.125秒、中位79.107→73.011秒、streams23→37，不能称整体提速。773双方事实误归因FAIL；774修后/778有界通过；780/783候选审阅分别错误替换3/4条实质旧结果，FAIL保留。
- 未收敛/未验：841短暂回填冲突具体分支未完全查明；下午786非法JSON/独立资源失败、788–790/817调度因果、803业务范围仍有缺口；固定摘要基线FAIL保留。真实Owner/附件内容/完整历史去重/真实钉钉及生产60秒目标未验。

## 本轮部署与近期消息结论

双包均2.3.0：Assistant SHA256 b8066ac3…、Observer 84e11494…，完整摘要及95/4文件独立核验见validation。-Check为writes0/signals0、候选quiescent/drained true、pending0；正式CTRL+C原生退出旧PID47836、剩余后代0，新PID60180接管3080/18998。旧owner进程退出但行仍stale，不写为已清除。profile摘要不变、自启Enabled、未建备份；当前DB/初始化标记身份一致，但无部署前marker摘要基线，不宣称逐字不变。

脚本readback初始健康正常，02:03/02:05 UTC因seq841直接关联的DYNAMIC_SOURCE_CONFLICT回填退化，监听仍ready；02:10自然恢复，未重启/重放。Lead最终02:12:32.8539010Z独立GET为ok、inboundProcessing true、bridge healthy、recoveryIssueCount0，两监听ready/两回填ok。单消息mget与canonical部分投影不同，但不等同失败的range入参，无实际异常栈，不能定性抛错分支或保证不复发。

原固定20条seq814–833：基线01:19→部署后02:11:35逐ID/version/processingState对照，仍11 processing、5 needs_clarification、4 processed；仅该口径无变化。833 v2的hold epoch1→2在01:20:53部署前自然发生，不称完整投影不变。5hold均无scope/clarification；T1 revision/processed/summary=56/49/49，T2=11/4/4，无新accepted，本批通知/outbox直接关联为空。4 processed属out-of-scope处理，不是群回复送达。部署与健康恢复未解除业务等待。

原生GNU tar工具环境预检失败未停机；C交唯一执行权给Lead原生PowerShell环境，不改PATH。实际tgz首轮health通过、Task超时；后诊断Task与3执行已完成，但合成fixture未消费Host summary nextCall而循环。C仅公共fixture5行消费同request精确nextCall，D审；实际包单项原30秒/原断言1/1、business27559ms、cleanup正常。fixture0e4f8ce6/test e123bcf7前后不变，产品包不变。原失败保留，诊断轮曾改诊断投影，不能绑定单一blob。

## 团队与证据入口

A负责schema/runtime及已完成只读冲突合同核验；B唯一写coordinator，未绕其限制；C负责fact/隔离评测、5行fixture与最终去标识validation；D只读独立核，不写业务；E负责报告/matrix；Lead唯一Goal/Git/PR，并因已证工具环境差异承接本轮Native及部署执行权。五会话保留，当前无新增实施或在途操作。

- 本轮最终证据：round-15.md、round-15/validation.json及必要TAP；matrix追加历史不覆盖，未写整体report.md。PR #342正文按真实安装/健康/卡点事实回填并独立回读；收尾分支不续推#342。
- 原计划：docs/spec/first-reply-latency-contract.md、docs/spec/structured-routing-host-execution.md；已交付旧任务round-7/8。当前runbook为docs/ops/task-session-clean-start.md的已初始化原生双包更新，不Bootstrap。
- 历史验证：round-9核心250/下午观察；round-10五超时；round-11相关Native57；round-12旧隔离/凭据；round-13真实五对；round-14新核心237、fact2、history5、隔离3。按实际版本引用，不重复累计或将脚本模型说成真实质量。
- 私有metrics SHA256 aa1562bf18fb9c51c26d242255409e922c243c8340609c95b32be26ff56636e1。toolIsErrorCount仅isError=true，不含isError=false业务拒绝，不是网络错误数。基线recent-processing-predeploy.json SHA256 8f485479928e362d3461ef23091bb5e729a141701c7ca386b6d800850d111ab9。
