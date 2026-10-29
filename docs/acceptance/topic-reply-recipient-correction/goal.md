# Topic 回复对象与收件人纠正修复

> 状态：COMPLETED
> Goal ID：topic-reply-recipient-correction
> 最近维护：2026-10-29T18:37:06+08:00
> 权威目标：D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-reply-recipient-correction/docs/acceptance/topic-reply-recipient-correction/goal.md

## 总目标

Topic 语义决定回复内容和对象，Host 验证并执行，不能用 basis 最后发言人覆盖语义对象。明确收件人纠正应形成适当沟通处理，不因不需要新建/取消任务而吞掉；不强制每条纠正都另发一条。

任务交接来自既有主控会话，沿原六窗口协作，不更改UUID、环境、模型或权限、不重启。旧PR #291已独立回查MERGED，不再push旧分支。新基线fetch成功为63ab508b502c8d2576a654e9be2f15225031d7ff；独立ls-remote遇网络TLS错误，未以它证明额外结论。

## 完成条件

- 本地脱敏fixture复现最后依据发言人非语义收件人及明确纠正只记事实的问题，修复后相关回归通过。
- 来源/引用/群归属/收件人身份有验证，不硬编码姓名或纠正关键词；重复输入与发送恢复幂等。
- 普通确认、完成/阻塞通知相关路径不回归，独立审查无未决阻断；同步README/相关ops。
- 新隔离分支提交、push、新PR并独立回读真实状态，不部署、不合并、不触发CI。

## 范围与约束

- 不现场补发/撤回，不操作正式库，不重放真实消息，不发送钉钉通知；仅临时数据、脱敏fixture及通知桩。
- 不扩展为全套跨Topic主回复架构，不扩大任务授权或跨群收件人授权。
- 只用PowerShell 7及专用Read/Edit/Write/Grep/Glob；禁Bash，不改全局配置，不绕过工具拒绝。
- 主检出已有用户改动一律保留；仅在新worktree作业，禁止旧分支push。
- 所有产物限本桶及docs/spec/；保留各轮报告、历史matrix和最终必要证据，清理仅本任务无用临时附件，不清理旧任务或其他会话资源。

## 当前检查点

- 当前子目标：SG6
- 当前状态：COMPLETED。普通merge提交1f3e034c已独立核双亲9675c13a/fd631460并正常push；同一已过门禁正文更新PR297后，18:37独立gh回读OPEN/MERGEABLE、mergedAt=null、statusCheckRollup=[]，headRefOid与独立ls-remote均为1f3e034c063af7546b6cae92f1b9b63acf95997e。最终稳定版12+2+5及Lead亲跑inbox1均PASS，round-17含四组命令/耗时与最终独立审查；矩阵57条历史/30 cases，最新26 PASS/4 OUT_OF_SCOPE、无重复或未决。
- 唯一下一步：交付后等待PR评审；无新实现、测试或审查待执行，不自动合并/部署/CI。该检查点随文档收口提交交付，不改变已验证源码；六原窗口保留。
- 未闭环项：本任务范围内无工程阻断；真实LLM/现场/crash未验、旧prepared超时根因未证等边界保留，不视为已验证。
- 工作目录：D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-reply-recipient-correction
- 分支：worktree-topic-reply-recipient-correction；base main。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
|---|---|---|---|---|
| SG1 | platform：前置机制与基线反例，只读源码及mechanism报告；Lead独占spec/goal | 真实调用链、三方案比较、可复现失败与安全边界 | 完成，机制已独立回读，后续行为归SG3 | spec；mechanism-round-1.md；tests基线1FAIL/4554.1953ms/exit1 |
| SG2 | implement：语义收件人与沟通修复，独占packages/ | 复用现有能力，Host不覆盖对象，任务保持也可沟通 | 完成，已审路径暂无已证阻断 | round-3、10、11、13、15；service:1341 |
| SG3 | tests：独立测试与回归，独占test/ | 复现和纠正、歧义/跨群/非助手引用拒绝、幂等恢复及通知回归 | 受控代表测试完成，真实模型同名消歧及现场验收未做 | 定向13、关联177、冲突2、prepared1、手写6、材料1、通知恢复6均PASS；保留历史失败 |
| SG4 | review：独立审查，只读实现/测试 | 无已证阻断，盲点明确 | 完成，已审源码及测试暂无剩余已证阻断 | 原错taskIds外发FAIL保留；修后send0通过；三处仅补route，单真人默认不证明多参与者语义；未验边界保留 |
| SG5 | docs：合同及验收文档，独占README/相关ops/matrix/round/report，不写goal/spec | 历史失败保留、证据可追溯、全绿后报告 | 完成，已交接Lead单写收口 | round-16/17与ops已核；report.md及矩阵最新26 PASS/4 OUT_OF_SCOPE |
| SG6 | Lead：整合交付，独占goal/spec/commit/PR | 独立核验、本地实跑、新PR状态回查 | 完成，PR297 OPEN/MERGEABLE；未合并/部署 | 整合1f3e034c；正常push后独立gh及ls-remote同SHA，round-17稳定20 PASS与最终审查 |

## 进展

- 已核新基线AGENTS：普通开发禁止主动触发CI，风险相关定向测试与历史路径按影响覆盖。主仓不切分支、不提交用户文件。
- 已核原五会话：implement[a88fbc]、tests[3e018f]、platform[f68c34]、review[b30ab5]、docs[7aebb9]，均interactive/idle。保留六原窗口。
- 现场线索只作待核输入：多依据确认对象被选为最后发言人；后续收件人纠正被actions=[]吞掉。不复制群ID、成员实名或真实消息ID进入fixture/PR，不把这些线索当本地复现结果。
- S3真实基线：`node --test --test-name-pattern='多依据普通回复应指向语义接收人' test/topic-runtime.test.js`，63ab508b+仅测试diff，tests1/pass0/fail1/cancelled0/skipped0，4554.1953ms，exit1，outbox实际explanation-b vs预期request-a。当时decision无显式route，只证明Host选择最后依据人，不证明Host应推断未给语义对象。当前测试已补显式字段，Lead独立git diff读到；不重复跑原基线。
- 前置spec已在修改源码前落盘，比较顺序猜测、Host关键词与显式路由三方案，推荐复用replyRouting。platform机制报告已完整回读，额外指出formatter覆盖多@、同outboundId未比@、媒体不可用重建decision丢字段、历史冻结payload混新args风险；源码与test单写负责人已获具体反馈，review独立查反证。
- 安装日志453包done且exit0；独立require(zod)及realpath证明本次workspace链接指新worktree源码。首次goal校验因表头/维护时间不符失败，已修为精确五列表头和ISO时区时间，validator后续PASS。
- 稳定首版5文件已由Lead独立读取diff；无store schema迁移。review已给notification-only最小真实投影反例：taskNotificationOutbound不带decisionId，新readFrozenReply严格比较误拒；已让implement与review收敛安全绑定，并让tests验证完整service组合。公共prepared分支冻结route、topic revision绑定、纯web外发仍待验，不把静态疑点当已证线上缺陷。
- review反证cancelTask循环在当前生产coordinator注入noop，因此不能声称生产恢复会重复取消；泛用适配器风险单列，不借此扩大重构。
- review已补纯Web反证：真实submitWebTaskInput固定decision.reply=''且源web直接routed/delivered，普通create/replan不会经过新非空reply formatter，故不能只凭allowUnrouted认定外发回归。真实service路径验证仍待tests，若有新增外发应定位后续task-facts/完成通知，不把直接Web动作当非空decision。
- 首版稳定通知之后已进入恢复修正窗口，tests较新回执明确无在途；Lead撤销重叠首版跑测指令，以成员直接约定为准。当前无修复后PASS可记，旧基线FAIL不覆盖。
- 稳定首版至恢复修正后的定向测试已收到tests原始数值回执：runtime 11 PASS/0 FAIL/0 SKIP/736.5143ms，decision媒体1 PASS/0 FAIL/344.2592ms，指定native profile的service多@与recover用例1 PASS/0 SKIP/2725.3845ms，均exit0；模型与通知均为桩，不是现场LLM/钉钉验收。docs待收完整命令与证据。关联完整回归曾exit1（最近回执177项174 PASS/3 FAIL/0 SKIP），tests在补新合同下旧fixture显式目标；其中原reply-owned-by-other-topic变invalid-arguments的返回合同差异交implement判断，不能静默放宽断言。恢复组合仍未完成。
- 独立审查增量回执：原notification-only投影、公共prepared冻结路由、revision三项源码阻断已解除，未报告新增已证阻断；完整service行为仍以实跑为准。历史notification缺任务版本不能声称已验证该身份字段；fixed-topic空refs属于基线疑点，不扩修。本轮Lead再次独立读取service:726-803、核新分支及diff --check通过。
- Lead于16:38独立读round-2完整命令/结果及matrix：已确认定向13项受控行为通过和关联177项174 PASS/3 FAIL的记录；发现同case+round重复及综合来源/引用安全项PASS过宽，已交docs合并重复、拆分已验与未验。已请tests优先提供既有非助手引用/同名歧义/跨群负例的名称与结果，确无覆盖再补最小反例；提示词不能证明真实LLM消歧。原归属返回合同修复由implement负责，不能借绕过routing接纳无合法路由决定。idle通知只作核查点，不作结果。
- 较新终态已接回：implement直接拒绝foreignReply并清请求/调度，不跳过routing去接纳；review报告该增量6/6 PASS、0 SKIP、无已证阻断（无路由不接纳仅限真人非空回复）。tests关联177/177 PASS、0 SKIP、6596.2022ms、exit0；Lead独立读取runtime:1028-1044确认实际落盘。已通知tests/docs以此较新终态为准，不重复177，原round-2失败保留；notification-only/prepared/revision等完整service组合仍待tests。
- 交付准备：Lead已独立回读round-3的177全通过、round-4的6项审查复验和README公开合同diff；PR正文草稿保存本桶pr-body.md，明确恢复与引用身份仍待补证据，不创建PR。已查.github两份workflow：兼容CI仅workflow_dispatch、Release仅v* tag/manual；普通分支push/PR不触发这些CI，不调用手动入口。
- 17:02接续核验：Lead已独立读取tests会话tasks/bvlzff8n9.output中的结构化invalid-arguments诊断及最终summary/exit，并读当前native:52-57确认夹具已移除replyTo；round-6保留36 PASS/1 FAIL及待复验。已明确通知tests接续定向复验并继续恢复组合/共享helper影响验证，不等待旧已终态后台，也不将已落盘修正算PASS。PR草稿同步同一失败事实。
- 恢复新增反例：tests回执正向prepared/projected补全basisUnitRefs后2/2 PASS，但同outbound revision-conflict观察decision blocked而prepared scanner仍send桩1次。Lead独立读取native:372-415构造与断言，已交review沿notificationDeliveryGate核对应decision/outbound冻结身份，直接与implement/tests协调修复；不通过改prepared状态或减少无外发断言掩盖。此前源码“无阻断”仅是早轮结论，当前已重开SG4；无decision通知、sent及unknown/starting回读状态合同仍须保留。
- scanner初修及新反证：Lead独立读service:1332新增门禁和scanner:1393-1408，prepared及明确known-not-sent可重试才做冻结校验，unknown/starting/delivered不新增阻断；初修frozenReply漏传expected taskIds。review真实native/临时SQLite反例为同group/Topic/revision1/outbound、原actions=[]/operations=[]，prepared.payload.taskIds=['unrelated-fixture-task']；decisionStatus=blocked/error=group_reply_frozen_identity_conflict，但sends=1且sentTaskIds错误。已交implement按record.operations派生taskIds传同一helper，tests仅扩原恢复参数保留原反例并复验，不重复已有探查。
- 17:20接回round-9及最小修复：Lead已独立核service:1341含record.operations派生taskIds、native:384后保留同refs错taskIds及send0断言，diff --check通过；但round-9已有新终态2PASS/2FAIL/1CANCEL，不继续等待旧结果。Lead只读调用链排查：service.whenIdle:1877-1885仅等service的inflight集合；runtime.recover:1596只await schedule，wake:692调用resume未await，因此立即读取accepted可能观测过早。已请tests有界等真实terminal后保持原断言；prepared取消另找堆栈，不借此假设一并解释，不盲改生产模型。
- 17:34代表组及手写fixture反证：Lead已直接读tasks/bf23i9l28.output，两个原生用例PASS，精确summary/exit已发docs。另对native测试内手写decision做窄搜索并读原文，发现service-native:179真人context/cancel、web-topic-reuse:18真人原图proposal缺replyTo；background-retry:21-23直接accept后期望原Host pre-effect重试completed/outbox1，缺normalized route。已交tests最小迁移和定向验证，第三构造当前正常接纳后的replyTo+at，不把它改成专门legacy负例；coordination-latency故意非法reply+reason和旧冻结恢复负例不机械补。不是全量测试扩张，是新合同必要受影响调用方。review独立复核。
- 冲突重开：PR初次及文档回填后独立回查均OPEN；最终回查显示CONFLICTING。Lead于18:11 fetch确认main=fd631460，隔离分支执行 `git merge --no-commit --no-ff origin/main`，真实唯一UU为 `packages/dingtalk-dsh-assistant/task-topic-coordinator.js`；service、README、ops自动合并仍须语义审查。implement负责冲突文件，tests待稳定后定向实跑，review独立核，docs记录新基线round；不把旧结果当新基线通过。
- 整合闭环：拒绝恢复旧协调prompt的中间解法后，最终coordinator以main为底仅保留readFrozenReply参数/透传与语义收件人提示。稳定版runtime12、退役2、native5及Lead inbox1均PASS；最终独立审查已审路径无剩余已证阻断。round-17/矩阵/报告已补齐，保留历史失败及边界。18:36普通merge提交1f3e034c，正常push并更新PR正文；18:37独立回读PR297 OPEN/MERGEABLE、mergedAt=null、checks空，远端与PR头一致，交付阻断解除。

## 重大决策

- 不在Host使用姓名/关键词识别纠正；先复用replyRouting与已有显式通知选人能力，语义决策和执行校验分层。
- 不以actions=[]等同无需沟通，也不要求每条纠正无条件发消息；按经验证语义输出及幂等账本执行。
- 新真人非空reply显式replyToMessageId；at省略或[]沿既有replyRouting语义默认@已选目标作者，非空数组必须唯一且同Topic参与者。仅web/internal无真人来源可无目标且at空。接纳前固定request.messages及回复归属校验，持久化后恢复仍同revision，不依最后basis作者。
- 历史已冻结outbox/notification沿原ID/payload对账、sent不改不重发；无outbox但decision有显式route按固定版本重验；旧缺route且无冻结payload fail-closed待人工对账/重决策，不重放已成功Task action。notification-only也仅复用冻结身份，不能生成新route。review独立查反证。
- platform发现service中formatter的reply spread会覆盖显式多收件人，属贯穿链路必要修复，implement处理，tests需覆盖真实service而非仅runtime outbox。完成/阻塞通知现有合同不顺带重构。
- 共享fixture取舍：tests发现topicTaskCalls被23文件引用，原拟撤其新增replyTo并只包装当前native测试以缩小验证面。Lead独立读helper:251-258确认其普通分支固定new-task+非空reply，所有实际真人调用都受新接纳合同影响，不会因helper未改而消失；因此保留最小共享修正，按真实调用区分受影响普通回复与不经该分支的summary/facts等路径，显式验证相关历史用例。review独立核来源选择及最小充分范围，测试文件仍tests单写；不为减少验证量保留已知非法fixture，不盲跑全仓。

## 重要信息

- 原任务goal留原位置且已完成，不更改它为新目标；本文件为新任务唯一主文档。
- 新环境需独立pnpm install --frozen-lockfile；禁止整体链接主仓node_modules。native依赖如需复用安装入口仍用临时root和通知桩。

## 交付

- 修复提交：aaa7d823b908f1ca2528cb39632b29f7a6cb9ea9；push后独立ls-remote一致。
- 新PR：[297](https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/297)，标题 `fix(topic): 保留语义回复对象并修正收件人纠正沟通`；最新独立gh回读state=OPEN、mergeable=MERGEABLE、base=main、head=worktree-topic-reply-recipient-correction、mergedAt=null、statusCheckRollup=[]。此前CONFLICTING历史保留；普通整合提交1f3e034c063af7546b6cae92f1b9b63acf95997e正常push后，headRefOid及独立ls-remote一致。正文已由同一过门禁文件更新并完整回读；后续只追加本轮交付状态文档，不改源码。
- 验收：report.md；矩阵57条历史/30 cases，最新26 PASS/4 OUT_OF_SCOPE，无case×round重复。风险相关代表实跑和最终稳定合并版独立审查完成，不作全仓/现场结论。
- 六原窗口保留，无重启/关窗；主检出用户改动未提交。没有部署、合并、手动CI或真实消息副作用。
