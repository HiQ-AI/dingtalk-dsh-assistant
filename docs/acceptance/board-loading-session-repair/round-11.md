# 第十一轮：Bytebase 工单与插件人工审批分工

用户明确人工审批指插件流程。此前将 Bytebase SKIPPED 作为管理员配置受阻的结论撤回；第十轮仅保留历史运行取证，不作为正确审批来源的验收。

## 当前代码证据

新数据变更 v6 显式使用 assistant 审批来源，平台接口存在不再决定批准渠道。创建并独立回读工单后创建插件审批请求；Bytebase 的 SKIPPED/APPROVED 不替代插件批准。简单加列继续只核对准确表，不扩大调查。

真实 StageContract、生产 Host、Bytebase client fixture 覆盖新工单、预建未执行 Task、批准执行及独立列回读。驳回时仅关闭未发送的插件审批门禁并保留失败观测，最终输出 needs_revision；尚未批准期间零生产发送，旧冻结 v4/v5 的恢复用例保留。

审批看板原有 comment 输入未被后端保留。现沿已有 approval.decided 审计事件保存首个意见，同事务绑定决定、主体、渠道和效果；查询时批量投影。Web/钉钉低层认证、无权拒绝、重复或晚到决定不覆盖意见、关闭重开控制库后意见仍一致，均有独立测试。生产数据变更的现有 Web 审批入口限制保持。

群 wait 通知直接使用简短 summary，完整 condition 留详情；block 摘要包括实际受阻原因，不再自动拼出缺少、责任人、继续条件的长句。通知首报与重复扫描仍幂等。

实跑记录（不累加重叠数量）：

- `node --test test/workflow-data-change-external.test.js test/execution-effects.test.js test/workflow-approval.test.js`：38/38，本轮意见持久修正前。
- `node --test test/workflow-approval.test.js test/execution-effects.test.js test/check-resident-storage.test.js test/workflow-notification-obligations.test.js`：69/69，包含意见持久、首终态和拒绝零发送。
- `node --test test/workflow-notification-obligations.test.js test/workflow-trusted-platforms.test.js`：46/46。
- 历史原生 Service 自动对账定向：4/4。
- `node scripts/build-web-client.mjs`：退出 0，Observer 源码未改。

日志保存在 docs/tmp/simple-database-change-20261002/，不提交私人运行数据。

## 当前运行基线

原 Task 仍需求 r2、计划 r3，前三调查成功，第四阶段冻结 v5 原生待审。独立 Bytebase 回查 #857 / Plan878 / Task905，目标 hiq_editor，SQL SHA256 保持，Task NOT_STARTED。生产只读副本 recovery=true、readonly=on，name 列结果为空；没有批准或执行 SQL。profile SHA256 e026ce9c9f7447968a6a2c8c7b13486d96134031e1b6d07f6f96e877e6f87e6f 保持。

旧工单接续、正式包部署及群消息纠正尚未验收。本轮浏览器请求被 Browser 安全权限校验阻止，未绕过安全检查，未声称完成页面验收。

最新真实平台定向4/4：`node --test --test-name-pattern='真实 StageContract' test/workflow-data-change-external.test.js`，拒绝产物的comment与首个真实插件审批意见一致。69项低层/通知测试在加入拒绝效果观测持久收据后再次通过；拒绝收据由独立只读SQLite读取，mutationAttempted=false。

补充复跑：平台/接续/效果52/52、Owner恢复14/14。task-release-workflows联合23项中22通过、1项历史release冻结hash断言失败；独立读取原HEAD版本重建得到相同ffd212a4…，与本轮改动无关，未修改其它发布流程，也未把此命令记为全绿。

真实部署预检反证：旧v5纯原生审批观察unknown被maintenance统计为effects1，其它busy0，普通deploy Check 60秒拒绝，未安装。旧Host同时不认识resume目标，context尝试明确拒绝且原Task/Owner版本独立保持2/46。新增受控离线切换复用现有dispose见证、owner锁、完整备份、原生只读对账、seal、安装及恢复链；不绕过unknown、不直接写SQLite。新产物脚本及前置分析见docs/spec/readonly-approval-deployment-cutover.md。

当前最终代码组合121/121通过，HTTP/context/handoff/旧审批恢复12/12通过，包含HTTP合法Run revision0与CAS、维护、close及stop后中断重试。审批接续首节点已能正式注册。正式包已打包但本条记录时尚未安装：ca53d922184ba3b3c5131520f971ff44cf77a98b69fe9af822be02340b538810。

## 第九正式包与多 Run 修订

旧 message.web-task.prepare 将 runSequence 固定为1，导致已有五个Run的真实任务无法提交合法补充。现同事务读取该Task的实际执行数量，与详情的runSequence一致；真实HTTP一/二Run场景验证当前版本可接纳、旧版本拒绝、重复取消幂等。

- HTTP/context/审批交接/历史恢复定向：15/15。
- 消息账及受控离线审批对账：93/93，包含关闭观察后中断重试、完整备份篡改拒绝。
- 第八包已完成受控离线切换：旧纯只读审批unknown原生观察为failed，原Run保持waiting、revision0；未执行SQL。
- 第九包SHA256 eab211435d6edcdb4808a0644fb9e41ce30d1c158de7e8d987ea1b86b44185f9；零写Check验证100文件，正式维护备份、安装及新进程启动ready。业务接续和群纠正仍待独立回读，不将启动成功视为业务完成。

实际第九包接续反证：需求r3已接纳，Owner正确接受replaceSuffix第四阶段到已有工单接续，但applicationStatus=pending。原阶段running令applyPending保持等待，handoff又拒绝pending，构成生命周期死锁。现只允许准确对应当前需求来源和当前后缀的接续决定，不放行其它pending或runningOwner。原Run终止后先落账approval.channel.changed，使旧待落地决定因事件水位失效，再advanceTaskPlan；事件后中断重试仍补执行advance。该反证保留，不把round9安装ready视为业务通过。

最终HTTP/交接组合16/16通过，包含真实3项成功前缀、Owner native claim/candidate/accept产生待落地接续决定、事件后旧决定原生discard；其它pending决定仍零写拒绝。接续流程的实际并发边界由该用例证伪验证，未放宽Owner运行或未知写效果。

第十包只读交接checked/authorized均true；apply因服务deliveryOptions.externalAdapter漏挂closeReadonlyApproval明确拒绝，原Run及Owner未推进。已补受信operationAdapter转发，新增真实openWorkflowService构建路径的门禁观察集成，避免仅注入delivery fixture造成装配盲点。该运行失败保留；准备第十一正式包，不把dryRun成功冒充apply。

正式服务构建测试通过，内存加载时仅移除转发行即精确复现EFFECT_UNCONFIRMED；未改部署源码做反证。最终服务组合17/17、原生Owner会话15/15通过。Owner旧测试仍要求原生工单意见措辞，已同步为插件真实审批意见，首轮14/15失败记录留私有日志，最终15/15。简短等待约束沿已有共享groupReplyInstructions，不引入真实工单编号常量。

第十一正式包SHA256 d0fae5e2b74a8453397de439ccca6913bb146fb9fad04d195bb9ea60312f9669，独立安装100文件一致，fresh PID35388；完整备份、安装Readback、Resume已通过。原Task context r3已接纳，handoff dryRun authorized=true、apply accepted/event216；旧Run原生终止，Owner处理中，旧pending决定原生discard，前三成功成果保留。审批请求及最终群说明仍待独立回读。

原Task真实 r3/计划r4进入task-data-change-approval-resume，插件请求 external:cf8804d2ea31e067d11237570e440620e57f27e678838eea543da4085c566888 decision=pending、waiting-reply，准确SQL/数据库/工单857/包摘要均独立一致；详情kind=approval、责任方插件审批人。旧原生审批错误消息及本轮Owner长说明均撤回，七天范围complete=true/count0证实后仅引用原始需求发送简短说明；独立群查询count1，文本“Bytebase 工单 #857 已新建，等待人工审批。”（msgAoM30tPd8mGfzw3aFsSy+A==）。未批准或执行DDL。

实际投影发现审批objective仍取初始origin而非当前修订，已改读当前业务requirement，冻结Run/效果绑定不变，真实原生r1→r2回归3/3通过。实际Owner仍冗长说明证明prompt不足：通知现从当前运行阶段的prepared效果及pending插件审批生成准确工单短句，其它审批来源/状态保持原报告，避免伪造待审事实。准备最终第十二包。

最终简短工单通知8项原生SQLite场景通过：当前data-change/resume真实prepared assistant审批pending输出精确短句，重复扫描仅一条；已批准、驳回、Bytebase来源、其它流程及伪工单资源名不伪造待审。完整通知回归49/49；Owner原summary及审批账独立读回保持，详细证据仍保留。当前Task原始开始通知在七天完整查询中仅1条。

第十二正式包SHA256 975e570d9a533fcfbf0877f7e4be5e8390fc99b48ff7be1c2a2bf202a52df0c5，100文件独立一致，PID34504；Resume维护解除、health=ok/inboundProcessing=true、history verified。源码与安装的service/notification/ledger另行SHA256一致。插件待审requestId保持、目标文案为当前简短r3需求；SQL与#857准确绑定。Task r3/p4、Owner idle revision64/lease18、水位223/223、last_failure=null；三个成功前缀独立逐项完全相等。Bytebase Task905 NOT_STARTED/TaskRuns{}，生产只读name为空。

群最终独立回读七天complete=true/count1/failedCount0，仅指定简短说明。18:27旧版本另发的长等待在最终读回被发现并撤回，未重复补发。当前Task开始通知仍1条。最终服务20/20、通知49/49通过。

性能追加反证：最终新任务详情17010bytes，首次6738ms，三次连续6083/6205/5549ms；groups单次3765ms。原round2性能证据不能当作当前性能完成，SG3重开只读定位。当前浏览器安全校验仍不可用，未冒充当前页面验证。私有timing配方见plugin-api-final-timing.jsonl。
