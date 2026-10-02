# 看板、常驻会话与任务执行修复目标

> 状态：ACTIVE
> Goal ID：board-loading-session-repair
> 最近维护：2026-10-02T18:39:42.3094153+08:00
> 权威目标：goal.md

## 总目标

修复看板与任务详情加载、常驻会话目录权限及群名、重复开始通知；按用户批准方案修正 Task 决策与调查机制，恢复唯一原 Task 并推进到确实需要业务确认或批准的节点。

## 完成条件

接口、原生会话、通知及状态合同定向测试通过；正式包、进程、维护恢复独立回读；原 Task 保留身份与成功证据，简单加列经必要只读预检后实际提交 Bytebase 候选工单，最后进入真实插件审批待审状态；相关群消息独立回读。

## 范围与约束

保持主检出及已有未提交文件；开发在既有 worktree 和 PR152。沿原生事务、事件和租约，不增加第二调度器或持久 schema。生产 DDL 仅在本次精确 SQL 的插件真人批准后执行。私有证据放 docs/tmp，不提交凭据及业务工件。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | 群数据轻量查询与刷新去重 | native投影、历史全量等价、实际API/浏览器耗时 | 完成 | matrix.csv / round-2.md / round-3.md |
| SG2 | 常驻会话空闲挂接与当前入口 | native投影、目录/权限/群名、租约与关闭 | 完成 | matrix.csv / round-2.md / round-3.md |
| SG3 | 任务详情查询与刷新 | 同一真实任务前后耗时、投影正确 | 复核中 | matrix.csv / round-2.md / round-3.md |
| SG4 | 群通知事实与历史去重 | 同Task重评不重复、不同Task不误抑制、发送未知不重发 | 完成 | matrix.csv / round-2.md / round-3.md |
| SG5 | 部署及四项运行验收 | runbook Check/备份/安装/Readback/Resume+浏览器 | 完成 | matrix.csv / round-2.md / round-3.md |
| SG6 | Task与阶段分离、候选纠正及重复错误收敛 | 原生SQLite/原生会话/重启/完成清单70项PASS | 完成 | matrix.csv / round-2.md / round-3.md |
| SG7 | 结构化等待/受阻投影和受管恢复 | 同Task恢复、业务与系统原因区分、通知摘要 | 完成 | matrix.csv / round-2.md / round-3.md |
| SG8 | 数据库完整元数据与调查覆盖 | 原生只读查询、授权拒绝、分页及调查范围 | 完成 | matrix.csv / round-2.md / round-3.md |
| SG9 | 本轮部署与唯一任务真实推进 | 精确包安装、维护排空、原任务推进到真实等待点 | 完成 | matrix.csv / round-4.md |
| SG10 | 简单数据库变更送审与驳回修订 | 候选送Bytebase真人审批，拒绝修订、批准执行及版本绑定定向验证 | 完成 | docs/spec/simple-database-change-flow.md |
| SG11 | 部署及原Task真实送审 | 精确部署、原Task工单和SQL独立回读、群通知纠正 | 完成 | round-10.md |
| SG12 | 纠正插件审批入口与执行责任 | Bytebase建单后进入插件人工审批，驳回修订、批准执行、原Task接续及简短通知 | 完成 | round-11.md |

## 当前检查点

- 当前子目标：SG3
- 唯一下一步：定位原Task最新第六Run详情5.5–6.2秒的当前瓶颈；插件审批与群通知已完成接续，审批等待期间零生产执行。
- 未闭环项：当前任务详情性能复核；业务批准和执行等待插件真人审批，不将业务待审作为程序错误。

## 进展


2026-10-02新一轮：用户批准系统修正方案。当前PR152 OPEN，保持同worktree。直接原因为成功计划后block被拒绝，release一次将Owner置blocked；调查工具columns只返回三属性，代码分页nextOffset=400未读取。阶段、业务目标与Owner运行状态分层，沿用现有事务/事件/租约，不建第二调度器。结构化条件放现有decision；业务等待必须有恢复条件，内部拒绝在候选提交前反馈；完成仍逐项验收。当前生产DDL不在本轮授权内。下一检查点：合同与实现定向验证。

核心里程碑：共用validateDecisionState在candidate/accept执行，wait/block condition强制；成功计划后append不需要无关新消息，授权仍由Controller核验。原生会话第一次反馈、相同错误第二次停止，原错误明确保留；70项实跑通过。reassess从计划succeeded判断改为Owner已应用complete判断，允许成功调查的未完成Task重评，排空/来源/未知效果约束不变。当前资料地图明确dataset就是Editor后端，不需扩授权，后续调查应先读取地图再搜索。下一步：新调查v7与历史v5/v6摘要恢复及实际只读smoke，再正式部署。

/state/groups 28068ms/3367054bytes，逐Run完整message.run导致大节点解析及worker往返，前端每5秒重叠。保持全历史，不用截断兜底。native session/list 当前新协调会话header cwd正确但大继承离线投影为空；保留空闲只读挂接，不修改宿主核心或旧历史。

同Task原计划1和恢复计划2两次started已送达。原调查阶段完成但Owner last_failure TASK_OWNER_BLOCK_CONFLICT，尚未证明整个生产变更完成。

2026-10-02：联合原生会话/协调器/前端/通知回归101项通过；补充详情切换旧响应测试后前端24项通过。详情定向6项、收信箱相关16项及轻量大节点投影1项通过。UI strict audit错误0、警告0。部署Check零写通过，Assistant100文件校验通过；进入排空、备份与精确包安装。

第二轮：首轮群接口仍有通知补发逐条查询，按同页通知ID批量读取，原生2项及服务16项回归通过。群API1512–2248ms，详情2083–2712ms；真实看板2956ms、任务卡片详情4519ms。实际打开当前群会话，标题完整、完全权限可见、目录原生回读正确。重复第二条开始消息已撤回、完整群范围count=0，原始开始精确回读保留。最终PID40044、维护解除、精确包回读通过；四子目标运行验收均完成，matrix第二轮全PASS。

本轮核心70、服务38、通知41、查询调查30实跑通过。C盘满造成一次环境失败，D盘TEMP复跑通过；未清理其他文件。精确包fe523fe06e35b6712adbae1cf9dc3700659b2ddf7073c56b34875732ad7df29e已正式安装，PID25792；Readback及Resume通过。原Task受管重评event204，Owner同session lease6 running，下一检查点为新调查实际证据与结构化业务等待。

真实反证：stage-2已成功但只引用原dws消息，漏掉全部实际数据库证据和必要资料/代码，运行验收FAIL（matrix round3）。通知条件及系统阻塞清除已验证，不等于调查完整。补齐Host原生成功查询集合验收，新v8保留已部署v7历史摘要，再二轮部署/重评。

## 重大决策

阶段成功、Task 完成和 Owner 执行状态分开；wait/block 必须结构化条件。候选与接受共用校验，重复无效决定收敛为执行异常。新调查v8从原生成功工具回执重建查询证据，明确引用或排除；保留v5/v6/v7冻结合同。受管重评复用原 Task，不改写旧成功成果。

## 重要信息

Agent工作区D:/baibu-agent，运行profile D:/dsh_home/profiles/web，API18998、Web3080。目标Task task-e7e25daf5c0aac2f8bcb5ef13daef45f，Owner owner-7e9271fcc177db7025850a7527e7ac655b7c6fd1。Editor后端为已登记dataset，先读授权知识地图定位，不需扩权。状态以matrix.csv为准，第三轮真实反证保留。
最终检查点：v8精确包PID32460，原Task stage-3十五查询全部计入证据，代码六页1153文件，合法业务wait零失败；页面和群独立回读，旧等待说明撤回。10:05:21实时接入health=ok。PR152 OPEN，当前已推送f32a538，收尾文档另补提交。

2026-10-02新要求：用户批准simple-database-change-flow方案。恢复为ACTIVE；保留原Task及既有证据，新增SG10/SG11。原目标和验收不得继续将完整字段用途/代码调查作为送审前置。

当前检查点：简单数据库变更 v4、调查 v9 和原 Task 明确需求修订入口已实现。核心定向 65 项、平台数据变更 27 项、Host 36 项、任务服务完整 213 项通过；生产只读加列预检通过。待补部署、原 Task 实际送审和群通知纠正的独立证据。

真实运行反证：原Task context修订被末调查Run终态校验拒绝（RUN_TERMINAL），原生审批等待代码未纳入服务自动对账路由。两个生命周期同因缺口正在定向修复；第一包部署健康不等于业务接续完成。

生命周期修正验证：原Task调查Run成功但Owner等待可修订，真complete/取消拒绝定向5项通过；审批自动对账和旧恢复屏障13项、原生批准/驳回/两轮重审3项通过。准备第二包精确部署及原Task实际送审。

第二包独立安装/Resume通过，PID19660健康。当前闭环点为明确requirement修订与Owner活动验收一致性（真实测试已红复现）；原Task仍revision1，不重复发送已拒绝事件，也不改写线上SQLite。

最终原子修订回归6项通过（HTTP + SQLite旧inactive验收独立回读），第三正式包部署进行中。验收以第六轮状态为准，第五轮真实失败保持。

原Task真实revision2已接受，验收同步独立证明通过，Owner已正确advance数据变更。但落账TASK_STAGE_SOURCE_CONDITION_INVALID，根因Host/计划核验两套来源读取（只认DWS vs认真实Web）。现统一canonical来源读取并补上下文修订到计划落账的集成用例；不伪造群来源。

统一来源集成已证明：真实HTTP修订 → 只读重评 → Controller追加task-data-change源条件可落账；篡改版本/操作者/引用及跨Task均拒绝。既有DWS条件回归通过；两项旧测试fixture按当前Owner准入合同调整，未放宽生产校验。待最终包部署后重评原Task，需求r2无需再次修订。

第四包PID26212与100文件a7db1a263a0088cfa5f92848fbcf759dcf9549b1be68437b717a6cc91752b794独立回读/Resume通过。原Task恢复反证：拒绝旧accepted/blocked的未落账计划决定使readonly重评被TASK_OWNER_REASSESS_FORBIDDEN挡住；正在补已核验来源、零effects、仅调查与无计划receipt的审计恢复边界，需求r2保持。

第八轮：已核验来源的零效果拒绝计划审计恢复回归通过；创建/执行身份与真实审批收据跨层修正45项通过，等待审批投影4项通过。审查发现简单加列全库基线仍为隐含前置，正在按明确候选目标表收敛；部署尚未开始，原Task r2保持，实际工单未提交。

第八轮真实工单857已创建、SQL和目标独立一致；未执行，真实Task905 NOT_STARTED、TaskRuns空、生产只读name列空。但原生自动创建未执行Task/DONE被旧假设拒绝，运行验收FAIL。第九轮修正原生语义，原857只读恢复且不重建；新增送审前manual发布策略保护及冻结只读节点恢复。管理员启用审批规则后须重新送审，不承诺旧SKIPPED自动获得模板。

第九轮包18856恢复仍被合法空ProtoJSON {}误拒绝（非未知执行）；原工单不重建、TaskRun仍空、生产未执行。第十轮严格解码合法空对象并按冻结只读节点成功证明准入恢复；35项原生协议及全链通过，等待精确第七包运行验收。

第十轮最终闭环：第七正式包 SHA256 9e3f0c216566e3c893aaa247da07bdb939ceca06565cf3de8f01a884a19b175a，100文件独立核验，PID45200，维护解除、health=ok/inboundProcessing=true。原 Task r2/r3 保留三项成功调查；Issue857/Plan878/Task905 独立回读，审批SKIPPED、任务NOT_STARTED、TaskRun空、生产只读name列空。原只读身份节点成功恢复，当前approval-gate等待BYTEBASE_HUMAN_APPROVAL_NOT_CONFIGURED，Owner idle且last_failure=null。错误群说明已撤回，新说明精确回读1条，当前Task开始通知1条。35项协议及完整原生流程、16项服务恢复和控制屏障通过。修复目标COMPLETE，业务审批仍等待管理员处理；证据见round-10.md。

用户明确纠正：人工审批指插件审批流程，不是Bytebase平台原生审批。此前审批配置异常处理方向已撤回，未部署。SKIPPED不能作为插件流程阻塞；原Issue857未执行，需继续绑定本次SQL进入插件审批。执行会话仍负责处理实际推进问题。

插件审批修正进展：新数据变更v6明确使用assistant审批来源，Bytebase接口存在不再决定审批来源。真实StageContract/Host/client路径证明SKIPPED仍创建插件待审请求，批准后执行并独立列回读；驳回关闭未发送门禁并输出needs_revision，零生产发送。38项定向测试通过（workflow-data-change-external、execution-effects、workflow-approval）。历史v4/v5保留冻结恢复。当前运行未部署本修正，原工单857仍在旧v5原生审批等待；安全接续、服务投影验证、正式包部署、群说明修正尚未完成，SG12保持ACTIVE。

本轮继续：群通知不再自动拼接完整条件；审批页真实SQL及目标展示已补。UI现有comment此前被丢弃，现沿approval.decided同事务保存并批量投影；69项低层/审批/通知/存储测试通过，真实平台全链4项证明驳回意见进入needs_revision且零生产发送。只读回查原857仍NOT_STARTED、生产name为空、profile摘要保持。冻结v5交接由现Controller领域接续阶段实现，服务入口和受信平台按文件分工验证；待稳定后才打包部署。浏览器安全权限校验暂不可用，本轮不绕过或声称页面验收。

部署前置反证：普通Check因旧v5 pure审批unknown计为effects1拒绝，nodes/owners/messages均0，尚未安装。旧Host不认识resume目标，正式context拒绝，Task r2/Owner46独立保持。受控切换新增参数化领域对账与PowerShell部署，复用现有dispose/owner锁/备份/native观察/seal/安装/启动回读；不直接SQLite写或放开全局unknown。代码联合121项与HTTP服务12项全PASS，原Issue857保持未执行。
