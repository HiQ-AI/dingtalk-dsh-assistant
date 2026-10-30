# 固定话题路由类别

Task-session 的 Route 保留普通业务 Topic，同时提供两个稳定类别：职责外话题（out-of-scope）和职责内Agent平台相关（agent-platform）。类别通过 source unit 的 fixedTopic 字段保存，不是可新建、合并、关闭或续办的业务 Topic。分类仍由现有 Route 根据本群职责和原文语义完成，没有新增分类模型或关键词名单。

插件在打开存储时为已有群自动补齐持久化的 `group.fixedTopics`，订阅新群时一起保存两个固定项，不等待第一条消息或人工添加。归属键为 `(groupId, topicId)`，重复启动与并发订阅不重复创建，已有创建时间保持不变；升级只更新显示名，原 out-of-scope 消息归属、处理记录和纠正 API 身份不变。独立固定项不写入业务 `group.topics`，也不参加业务 Topic 的合并、关闭和任务动作。

话题归属与助手动作分开判断。“未交给本助手”不等于“职责外”：职责内业务消息即使指定其他负责人、来自其他助手的状态通知或引用同事信息，仍保留对应业务 Topic 的完整上下文，不以是否已有本助手 Task 为条件，也不因 @ 别人剥离原文。明确他人负责且未要求本助手参与时，Topic Decision 用 actions:[]、reason 和 topicUpdate.summary 记录事实，省略 reply，不承接、不唤醒已有任务、不追问、不回复；他人处理进展只作为其报告的业务事实，不能自动作为本助手任务完成证据。同时提出本助手诉求时仍按原文处理。只将真正超出本群职责的事项放入职责外话题，例如独立的职责外工具账号讨论。用户说“不是找你”只纠正介入意图，不自动改变业务归属；本批独立职责外消息仍按用户明确归类纠正。

人员别名通过现有群配置 `PUT /config/groups/:groupId` 的 `personAliases` 维护，例如 `{ "personAliases": [{ "alias": "小甲", "name": "测试成员甲" }] }`。该映射只适用于配置的本群，须来自已确认的组织人员信息或用户说明，不能凭相似字猜测；这里使用虚构示例；真实人员映射只写入实际群配置，不写入公开代码或文档，也不写死在通用算法。数组最多 32 项且整组 JSON 不超过 2 KiB UTF-8，alias/name 最多 40/80 字，别名不得重复；传入数组整体替换，省略保留、空数组清除，修改前应保留其他已配置项。更新后旧 Route 快照失效；Topic Decision 仅在本轮命中的身份映射变化时失效，提交事务再次核对，其他人员映射更新不干扰本轮。沿既有调度重新读取当前请求，不重放已处理历史。Route 和 Topic 仅携带当前正文或引用中命中的映射，不拉取全组织，也不默认传全部映射。映射解释身份，不等于派工：如“看小甲发的应该是这样吧”是在引用信息，不能据此认定给本助手交办或认成其他同名近似人员；仍结合上下文区分引用、通知和请求。

看板通过 `GET /state/fixed-topics?groupId=…` 读取上述固定项，在业务 Topic 前固定显示两个入口；没有分类消息时仍可打开空状态。`GET /state/fixed-topics/:topicId?groupId=…&offset=0&limit=25` 按原消息/unit 归属返回处理记录，支持全部群聊或单群筛选、`pageRevision` 校验与最多 100 项的分页。Resident 启动和提交群记录后维护仅含身份与排序信息的内存索引，GET 先取当前页身份再投影正文与回复，不遍历全部历史消息。记录区分待处理、消息处理异常、沉默、回复已准备和后续归类替代；回复沿用发件箱送达状态，不将“已准备”显示成“已送达”。

明确的人工纠正使用本机配置 API `POST /config/groups/:groupId/fixed-topics/out-of-scope/corrections`，仅接受 loopback Host/Origin 身份。请求为 `{requestId, reason, routingRevision, messages:[{messageId,messageVersion}]}`，一次最多 20 条，目标固定为职责外话题且静默；不是自动模型重判或重试执行。先用现有 `GET /state/groups/:groupId/messages?offset=…&limit=…` 获取真实消息 ID、版本与该页 `routingRevision`，不能把序号当 ID。服务端一次群记录提交保存人工 receipt、原处理状态/错误、所有新固定 unit 归属及处理完成；旧 unit、Topic 决策和已发通知留档。普通 Topic 追加移除关联，已空且没有任务引用的孤立 Topic 关闭；其他 Task 不变。看板标明“人工归类纠正 · 保持沉默”及原因。重启/重复 requestId 不重放，同 ID 异文拒绝；来源版本或路由版本过期返回 409，应重新读取确认；存在未完成决策、未结算协调来源或相关待发通知返回 busy，不能强制绕过。该入口不调用 DWS、模型、任务或通知发送，也不调度 Route，普通自动流程仍按真实 mention 证据处理。

本次 #416–422 的人工纠正理由是用户明确要求“这批消息应该都是职责外话题”；必须一次提交七个实际消息 ID，返回 `kind=manual-fixed-topic-correction`、`fixedTopic=out-of-scope`、`reply=silent` 后再回读固定页及旧 #419 Topic。操作不依赖未知的 @ 元数据，不发送补充群回复，不执行“重试几次”的业务。回执保留旧误判证据，不能描述成模型自行得出的结论。

职责外 unit 不进入 Topic Decision 或 Task Owner；职责外讨论和明确无需回复的纠正保持沉默，也不扫描 mentions。仅真正超出职责且明确向本助手求助的 unit 可标记 `outOfScopeHelp=true`；此时真实 mention 元数据证明被 @，才通过原通知链准备“这个不是我负责哦”。未标记或旧 unit 缺省为静默，已有冻结答复仍沿发件箱恢复。求助 unit 缺少 mention 元数据时，生产适配器按本群、原消息时间窗口调用 DWS chat message list-mentions，逐页核对原消息身份。读取失败保持未处理并报告错误，不能凭文本里的 @ 名称推断原生提及；静默分类不代表已确认无 @。

mentions 读取兼容标准 `result.conversationMessagesList[].messages`（`openMessageId`/`messageId`）及原有 `items`，按会话与消息身份精确核对，并复用 `hasMore`/`nextCursor` 续页。百部 DWS v1.0.63 的 [同版本分页实现](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/4cd5d05393a8748e89d9265eb9f7ec85745a0331/internal/helpers/paged_command.go#L259) 和 [空末页测试](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/4cd5d05393a8748e89d9265eb9f7ec85745a0331/internal/helpers/paged_command_test.go#L401) 明确允许会话列表在末页省略；适配器仅在成功且 `hasMore=false` 时接受此形式。非末页缺列表、显式损坏的列表、失败响应、解密失败、部分结果、缺少或停滞的续页游标仍报错。

平台整体问询使用独立原生 session，沿宿主正式接口 `permissionPresets.set(session, 'danger-full-access')` 选择完全权限模式。仅该会话类型移除插件的工具白名单和 guard，继承所选可信 preset 与宿主实际提供的工具，仍受宿主强制策略和用户授权约束，不修改其他会话或全局权限。`platform_task_query` 与 `platform_reply_submit` 在会话作用域真实注册；不能把这些局部工具放进只接受继承工具名的 `tools.restrict`。查询工具读取本群真实任务（包括同库归档），按状态和本地完成日期查询；列表分页返回 nextCall，提交前检查已发起查询的所有页读完。平台问询或汇报不创建业务 Task；具体业务进展如“导入修好了吗”仍归业务 Topic，混合消息逐 unit 分流。

时间型请求同时提供原消息 `messageTime`、执行快照 `asOf` 和群时区。判断结合用户明确时区和实际执行时刻重新核对目标，不把过去时间照原值安排，也不擅自顺延明天。仍有价值的状态汇报补报一次并说明实际时间与延迟；已失去意义的定点提醒可通过 `platform_reply_submit({text:null})` 静默结清。空字符串仍拒绝，普通自然语言输出仍不发送。未来请求只能使用宿主实际提供的 schedule 能力，真实创建成功后才确认已安排；确认不等于定时汇报已经完成。

即时平台会话仍为插件拥有的子会话（`origin=subagent`、`delegationDepth=1`），答复后释放。DSH `0.2.1-rc.2` 的原生 `schedule_create` 对该身份返回 `subagent_session`，这个宿主限制保留。一次未来事项改用 `platform_schedule_submit({title,prompt,at})` 提交意图，`at` 必须包含完整日期和时区偏移；Host 从当前来源固定原群、原消息版本、unit 和接收者，不接受模型指定目标会话或群。Host 创建新的普通持久平台会话，经正式 `ScheduleService.create(sessionId, request)` 创建原生 `at` 记录；不篡改原子会话身份或伪装 parent。新会话使用同一可信 preset 和会话级完全权限，其他会话权限保持。

原生 schedule 服务继续负责唯一的定时器、持久化、自动化列表和到期会话恢复。本插件只在现有 Resident `scheduler` 表增加可选的来源绑定及交付结果，按稳定来源 ID 复用接收会话。原生 create 已提交而本地回执未保存时，回读同会话原生记录再确认；并发重复提交只创建一个记录，删除后重试不重建。到期恢复重新注册平台查询/回复工具，读取当时的新事实，稳定交付 ID 沿原群现有 outbox/notification 发送；准备成功不冒称实际送达。原生入站提醒可能在崩溃后重复，已有 outbox 或交付结果阻止重复模型处理和重复发送。

即时确认沿原固定回复 ID；到期汇报使用同来源的独立 `-scheduled-delivery` ID，避免覆盖确认或重复补报。到期通知仍是 `fixed-topic-reply`，Host 必须从已保存绑定解析出实际原生 `scheduleId` 和 `scheduledAt`，并核对来源与到期时间；模型不能提供或伪造此通知绑定。两条通知分别沿真实通知账本、ACK 和回读结清。

若原生调度器先于 Resident 恢复会话，提醒正文要求工具未就绪时等待；Resident 根据原生的真实入站回执，在原会话空闲且尚未结清时恢复一次，不建立第二套定时器，也不增加普通成功路径的模型调用。原始消息版本或 unit 失效时结清为 superseded，不再交付旧要求。已经过期的新增意图返回 expired，不创建过去时间或明天的记录；停机跨过已安排时间时，沿原记录补报或判断过期静默。当前桥接范围为一次事项，不扩展周期调度或替代原生任务管理。

时区依次采用群 timezone、用户 Agent 配置 timezone、宿主默认 IANA 时区。可通过现有群配置/Agent 配置 API 设置 timezone，值按 Intl 校验。today/yesterday 以查询快照时刻的本地日期计算，返回包含左闭右开日期范围、时区及 asOf；按完成记录 at 过滤，不用更新时间冒充完成时间。

处理完成时间保存在现有 source unit 的可选 fixedTopicHandledAt 中；入站只有全部固定 unit 与业务 unit 结算后才完成。稳定原消息/版本/unit 身份生成同一个回复 ID，复用 outbox 和 notification 幂等、ACK、回读及重启恢复；已有冻结答复优先恢复，不重新生成。没有数据库 schema 迁移或新的 outbox/任务编排状态机，也不恢复 #288 暂停的 coordination 接纳链。

固定类别回复使用独立的 `fixed-topic-reply` 通知类型，`topicRefs=[]`，不伪造业务 Topic。Host 从真实 Resident 消息、版本、当前固定 unit 和发送人生成事实绑定，通知账本校验已接纳来源及稳定通知 ID；准备和发送前核对冻结来源。普通 `topic-reply` 仍必须携带非空业务 Topic 引用。若旧版本已写入 pending outbox、但因空 topicRefs 未能准备通知，恢复沿用原 outbox ID、正文、引用和 mentions 补齐账本，不重新查询生成或创建另一条补报。ACK 后只回读，不重发；真实送达仍以通知回执为准。

原生集成回归经过 `openTaskSessionService`、真实 SQLite 通知账本和原生平台工具，覆盖两类固定回复、业务 Topic 校验、非法来源拒绝及冻结 outbox 跨重启恢复。仅最后的外部发送/回读适配器为合成实现，未发送真实群消息。

验证覆盖真实 DomainFacility 的持久化/重启、固定类别分页与失败/沉默/回复状态、mentions 契约和静默人工纠正；浏览器使用合成 React 宿主验证键盘、空态、分页、409/503 与窄屏。相关原生回归使用 native profile 与确定性模型；`fixed-topics-native.test.js` 实际调用宿主注册的查询、回复及文件工具，检查会话权限隔离，并在提供 rc2 schedule 包时验证子会话拒绝、宿主一次调度、真实到期、重启、新事实查询、先于桥接恢复、原生记录及入站回执、交付去重和过期不误排。用 `DSH_NATIVE_TEST_PROFILE` 指向已安装 `@deepseek-ai/dsh-base`、`dsh-schedule`、`dsh-tool-schedule`、`dsh-api-session-controller` 的 rc2 profile 运行；缺少调度包的旧 profile 会明确跳过这些集成用例。时间指导断言与脚本化过期分支不等于真实模型语义验证。真实 DingTalk、生产库上的纠正和实际模型判断由部署后的独立验证负责，不能用隔离测试代替。
