# 任务会话清洁启动（2026-10-13）

本轮按用户最新要求采用新任务库，不迁移或兼容旧任务。此文替代旧迁移 Runbook 的上线步骤；它是现场操作方案，不能作为已切换证明。

## 准备及隔离

1. 明确停止旧 Resident、调度、DWS 监听/自动外发入口，核实原生工具和实际子进程已经排空。仍可能运行的外部操作必须按真实系统检查，空新库不会停止它们。
2. 将旧任务数据可恢复地移出活动运行路径，保留原凭据、源码、非任务配置及唯一验证证据。新代码不删除旧文件。不要把旧库当新库打开，不导入旧 task/run/node/effect/outbox，不复用旧 Resident storage domain。
3. 百部拟采用全新根 `D:\baibu-agent\task-session-runtime-clean` 和其下 `.dsh\task-sessions.sqlite`；实际执行前再次确认目录不存在或确为本次已初始化的同一实例。`agentWorkspaceDir` 指向新根，使用独立 Resident domain，防止旧 store 中的 workspace 设置覆盖新配置。
4. 保留必要群订阅、模型/preset、DWS 配置和经核验的用户身份。不要复制旧任务正文、旧会话日志或旧通知进入新 domain。旧消息身份/真实时间若留作审计，仅是去重元数据；本地 `sequence/nextSequence` 不是 DWS 服务端游标。

## 必填配置和时间边界

实际 Resident 必须显式设置 `taskSessions.dbPath`、`instanceId`、`ownerActorId`、`webActorId`、`ingressEpoch`，不回退到旧 workflow 配置。身份来自既有可信配置，不能由模型/消息正文填写。另建议显式设置真实 `assistantActorId`（DWS 发送者身份）：Host 结合该身份、可信 DWS 标记及本群通知身份识别自发回流，不按昵称或任意相似正文猜测；未配置该身份且回声先于发送回执落账时不能保证识别自身。

`assistantActorId` 只标识发送身份，不把该账号的全部消息视为通知。Host 通过已持久的发送/回读消息 ID、当前身份的 DWS 标记，或正在发送通知的精确原引用及完整正文识别回流；本人手动新指令仍通过监听/历史补拉接纳。群看板过滤通知而保留底层传输历史。回流过滤不等于完成通知送达对账。

`ingressEpoch` 是现场切换时记录的带时区 UTC/offset ISO 时间，不要把本文日期当成实际切换值，也不要每次启动重算 now。新建时显式 `initialize: true`，成功后改回 `false`。epoch 绑定 SQLite 元数据及初始化标记；重启不允许省略/改变绑定，不允许给已存在的无 epoch 库补绑。丢库或标记不一致应停止并取证，不能删标记强建空库。

DWS 启动监听 ready 后会自动回补。服务按原始 `event_time ?? create_time ?? timestamp`，历史接口 `createTime` 判定接纳，支持毫秒数字/13 位字符串；无时区日期文本按北京时间 `+08:00`。小于 epoch 的消息仅留幂等隔离收据；缺少真实时间同样隔离，不用展示用的 now 补值放行。被隔离消息不进模型、不下载材料、不生成任务或通知。时间恰等于 epoch 可接纳；同一来源重放仍幂等。

本机制依赖 DWS 真实消息时间，不把本地序号当流游标，也不承诺修复上游伪造/错误时间。epoch 之前尚未完成的交办不会自动继续，需要用户在新入口重新交办。

## 开放前核验

- 用新 profile 启动，核对实际 workspace、dbPath、instanceId、epoch 和独立 domain；确认旧任务/授权/通知均不出现在新看板。
- 运行实际 Web 构建并加载官方 ClientModuleRegistry 产物；进一步在现场浏览器确认页面能打开。
- 触发监听 ready 回补，证明旧消息和无时间消息被隔离、旧通知发送次数为零；再发送一条边界后的新消息，确认任务、执行、实际 JSONL 都落到新根。
- 同一消息重放和进程重启后不得重复建任务或外发结论。核对两个执行会话、取消排空、需求更新及真实回复引用/@。
- Windows 不具备 symlink 权限的测试明确记作未验证，不能关闭安全限制换取通过。

## 已初始化实例更新核验

发信箱四维状态梳理只更新 Observer，Assistant 复用当前受信包；按原生双包脚本预检、排空和安装。重载后核对发送状态、原因、替代关系、撤回结果独立展示，多个筛选取交集；已送达/未知不被旧字段覆盖，历史缺证显示已发送且原因注明缺证，历史撤回无重试承诺。独立对比更新前后通知 ID、送达状态、投递 ID、替代关系和撤回状态，不修改历史账或重发。仅核验 UI 不代表未知通知已经送达。

看板提示关闭修复仅修改 Observer，无数据迁移。原生部署脚本仍显式传入两包并校验摘要，Assistant 复用当前受信包。浏览器刷新后成功反馈应支持手动关闭且 5 秒消失；错误反馈支持手动关闭，恢复后清除，同一持续错误不因轮询重新出现。无需通过归档其他业务任务制造测试提示。

发信箱送达与替代关系修复更新 Assistant 与 Observer 两包，无数据库迁移；按下述原生脚本预检和部署。恢复后检查原已送达且被替代的记录仍显示已送达、替代关系单独保留，已送达筛选可见该记录，且不再显示等待替换通知送达后撤回。发送时间只读原消息回执，历史缺失不补写、不重发；界面明确区分未记录的发送时间与已有回读确认时间。

普通代码更新保留同一数据库、初始化标记、instanceId、epoch 和原会话目录，不重复清洁启动。当前任务会话运行时没有旧 workflow maintenance 接口，不能直接使用依赖该接口的历史部署脚本。停机前须通过当前宿主的原生生命周期停止接纳并排空，确认原任务/执行/群会话及实际业务子进程已结束；不能仅凭一次 SQLite 快照声称原子排空。普通本地部署不备份历史副本。

本机静止实例使用 [原生退出切换脚本](../acceptance/task-session-runtime-repair/scripts/deploy-task-session-native.ps1)：显式传入持久 Assistant 与 Observer 两个包及各自摘要、精确旧 PID、当前 profile 摘要及本轮证据目录，先 `-Check`，通过后同参数执行。脚本先核验共享控制台仅包含精确计划任务进程树，再经 Windows CTRL+C 触发 DSH 原生 SIGINT disposal；等待旧进程退出、SQLite owner 释放、原生日志回合结束和实际子进程退出后，才沿官方 `dsh plugin --profile web add` 安装。不修改 profile，核验其原字节摘要并还原自启状态，经计划任务启动并回读。失败保留现场与阶段记录，不自动强制重启；不得将其用于活动业务执行或其他实例。此脚本只支持既有已配置的本机身份与路径，不承担迁移。

恢复后核对包 SHA256、安装版本、新进程及健康，再分别核对收信箱、原通知及原任务。通知的 `openTaskId` 查询 SUCCESS 后仍须读取精确原消息核对群、发送者、原生引用及完整正文。DWS 缺少原生 mention 元数据时仅在这些精确发送证据齐全的情况下确认送达，并记录 `mentionVerification=unavailable`；不能把文本 `@姓名` 当作原生 mention 证据。unknown 不重发。

启动时 active、已排空、lastDecision=wait、无 question 且有 unknown 操作的任务，按相关运行模块摘要和当前需求/控制版本补一次 `runtime.updated` 唤醒。重复定时恢复或同代码重启不再补发；暂停、取消、人工问题等待和仍有执行的任务不适用。Owner 沿原任务调查并使用 `task_operation_reconcile` 核验，未知操作未被证明前不能放行原动作。

## 回退

### 人工介入与原生能力更新

本次无 schema 迁移，仍沿原生排空双包部署。技术申请缺省 operator，Web 人工介入保持原接口；私聊收件人来自当前 DWS profile 的认证 user_id，不使用需求提出人或人工填写的任务参数。新版将既有仍有效的待答技术申请登记到私聊通知账；已送达旧群消息保留历史，不重发。停用 DWS 外发或无登录身份时仅保留 Web，不回退群询问。

部署后独立读取 authorizations 的 audience/notification，核验私聊真实 messageId、会话、发送者及引用答复，再核验原 Task/session 恢复。原生调用不再挂插件文件边界、跨操作 unknown 全局门禁或合成全局写锁；沿当前 preset、danger-full-access、原生 sandbox/approval。核验 gh 查询和原任务日志读取，旧 unknown 记录及原业务完成门禁保持，不手改账或将历史未知伪装为成功。正文仅去除与受信原消息相同的前置重复引文，其他证据引文保留。

### 历史自身回声阻断话题任务更新

`TASK_TOPIC_SOURCE_VERSION_MISSING` 先对照固定话题历史与动态来源账：已核验的自身通知没有用户准入来源是正常情况，真实消息缺失则必须保持拒绝，不能补造授权。新版任务更新排除通知账/可信发送身份核验的自身回声，并在所有动作落账后才准备话题回复。

更新仍沿本页原生排空与精确双包部署。对已确认属于该错误、动作尚未应用且任务版本仍当前的消息，通过现有 `POST /config/groups/<groupId>/messages/<messageId>/retry` 显式重试；入口复用原动作恢复门禁。旧版提前发送的回复可能已投影为 `task-notification` 来源，新版沿稳定 outboundId 核验正文、决策及引用身份，复用原生通知收据并回读当前态；不拿旧 prepared 收据覆盖 delivered 缓存。若旧恢复已停在 `outbox_identity_duplicate`，且全部动作已应用、失败点是该回复、原发件箱身份存在，同一重试入口仅恢复回复收口。既有已送达回复不重发，原任务/会话和完成执行结果保留。部署后独立回读话题 processedRevision、动作状态、人工请求、原任务新增来源及原生会话承接。其他未知效果和版本冲突不在本恢复范围。

新旧服务不得并行消费并执行同一群消息。需要回退先停新监听/外发与实际执行，保留新数据库、初始化标记、日志及真实外部效果证据，再按审阅后的旧实例配置恢复。清洁启动没有把新任务转换成旧工作流，不能恢复旧服务后自动重放新任务。旧数据的可恢复隔离与删除授权是两回事，不执行永久清理。

任务与动态执行会话直接使用配置的原生工具，不添加工具白名单；readOnly/readbackOperationId仅用于关联原操作调查与对账材料，不用工具种类代替事实核验。原生权限、来源版本、真实生命周期及未决效果账继续按实际状态判断。即使Observer源码没有变，也必须显式提供当前已核验的ObserverPackage及摘要：官方安装会重新解析profile既有overrides，单独安装Assistant可能回退Observer。两个包均经源码/安装读回核验。

统筹更新核验需区分新增Host输入、保留的旧Host内容与整个模型请求。检查原生surface仅保留当前Host快照，旧快照及旧版历史标记不再占模型消息，原审计输入仍存在，执行previousExecutions不递归。目录里的终态不是业务验收证据，须沿resultRef读取原结果。对模型过载查看本lease的turn/end：临时过载保留wake，按现有retryIntervalMs退避后续办同会话，不把其写为业务blocked；旧版误blocked仅凭原生日志精确识别恢复。看板中统筹等待尚在执行的小目标仍为执行中。

阶段唤醒更新无schema迁移，按本页静止实例双包流程部署。普通operation.settle仅在原绑定完全匹配、执行仍运行且未排空/取消/恢复/修订失效时省略统筹唤醒；执行自己消费真实成功/失败。unknown、cancelled、对账、独立操作、迟到结果、阶段成果、执行结束和用户输入仍唤醒。验证时比较实际wake账与统筹回合数，不能仅断言工具返回成功。现场已等待真实人工决定时保持原请求，不为测试制造一次无意义统筹回合；可用精确原生输入对安装包做只读投影复验。此修复不删除已有会话历史，正常历史仍沿原生压缩处理。

人工介入核验：待答请求在/state/authorizations返回taskSessionRequest=true、status=waiting-reply，任务归等待中；POST /tasks/:taskId/human-requests/:requestId/reply只接纳本机受信Web请求，body含幂等requestId、reply及expectedRequirementRevision/expectedControlRevision。原文保留真实配置webActorId，旧版本/已答/非当前请求拒绝，成功后原task/session继续。修订或终态将旧申请superseded；不得通过手改账或伪造答复绕过边界。

进度巡检核验：execution.progressReview.checkedAt为持久上次检查时间，running当前版本到期600000毫秒后由既有recovery tick读取原生日志；wake.kind=execution.progress.review。统筹未调用task_execution_progress就提交会收到TASK_EXECUTION_PROGRESS_REVIEW_REQUIRED纠正。缺文件、身份/输入不匹配或无新记录如实呈现，不能仅查状态宣布推进。巡检不发额外群进度消息，不清unknown效果。

任务会话因查看记录而被普通空闲Agent占用时，不热抢Agent、不改SQLite的drained字段。先读取原生API核实running=false、inbox为空、所有执行已结束，再走精确进程的SIGINT退出。部署检查对未开始的新lease须同时核验原生日志：没有当前lease输入、上一回合已结束、工具调用全部结束；停机后还必须独立证实旧PID消失。保留未开始lease，由正式重启恢复路径接管。同任务出现新Host输入才算恢复，health=ok不替代此项证据。

## 原生网页读取错误恢复

本修复无 schema 迁移，沿上述静止实例双包流程 Check、原生退出、安装和回读。部署后对仍待答的原技术申请说明修复已安装，要求原统筹先调用 task_operation_reconcile，再续办原执行。Host 只读核验原网页工具调用身份、参数和错误结果摘要、同轮 completed 结束记录及当前排空状态，以正式事务将该笔旧 unknown 转为 failed，并保留原记录。未知写操作、取消回合、仍活动 job、摘要不符继续拒绝。不得手写 SQLite、重放原 URL 或拿新的读取代替原终态。独立回读 operation 的 failed/previousObservation/proof，以及原任务的新执行输入；健康恢复不能替代业务交付。

## 2026-10-14 恢复统一工作区及现有数据

当前Agent工作区和taskSessions.workspaceDir均为`D:\baibu-agent`，数据库位于`D:\baibu-agent\.dsh\task-sessions.sqlite`，resident storage位于`.dsh\resident`，任务及会话在`tasks\<taskId>\.dsh\sessions`，共享会话工作目录在`session-workspaces`。上文clean根是当时清洁启动步骤的历史记录；当前`task-session-runtime-clean`已完整迁出并移除，不再作为运行入口。

迁根必须先零写入Check、确认唯一写者和原生回合停稳，再迁当前路由/材料/Workspace/数据库保护路径绑定。原生记录通过官方persistence.create新cwd+append原事件，并核验原事件前缀摘要；历史input、收据和业务正文不全文替换。既有目标子项不能覆盖；所有新位置独立读回后才清除迁移暂存。一次性脚本与原生续办证明在`docs/acceptance/workspace-root-restore/`，固定旧源不存在时不可重复apply。普通部署不需要重做数据迁移。

## 显式后台服务回执恢复

显式 run_in_background 返回原生 job 身份及 running 收据，不等待常驻服务退出；前台超时提升仍等待终态。服务归单个 execution，使用原生 job_output/job_kill 检查与停止；提交前应清理服务，执行排空也会停止残留原 job 并记录真实终态。后台 operation 在排空结算前保持 starting，running 不是业务验收。

job_list/job_output 只读取原生注册表。会话释放后job已移除是实际查询失败，原持久终态仍在operation/job收据中，不能据此重启生产者。旧版将该查询误记unknown时，原统筹调用task_operation_reconcile；Host仅接受精确missing-job拒绝、原调用摘要、正常回合结束及排空证明，记failed/noEffect并保留原始账。同名不受信工具、job_kill、写效果和任意其他错误不在恢复范围。

部署脚本在实际执行阶段自动创建工作树缺省的 docs/tmp 锁目录；Check 阶段仍为零写入。失败轮次证据保留，修复后使用新的证据目录。

显式指定Observer包时，安装后以该包及源码核验安装内容，不要求旧Observer manifest字节摘要保持：pnpm pack可能仅格式化JSON。profile仍要求原字节摘要。若安装已成功却因旧manifest字节门禁误报，先独立核验两包、profile、旧PID和离线账本，再沿原计划任务启动阶段完成；不重新安装或手改账。

已陷入旧 collector 的调用不能仅换包热恢复。先核对专用服务 PID、启动时间、数据目录、端口和原 operation/job/session，零副作用检查后正常停止该专用服务，让旧 collector 产生真实工具终态。保留原 pgdata 和原始收据，不重放旧启动、不手改账。静止实例双包 Check/部署后，由原任务回读停机事实及对账结果；需要再次使用服务时，原执行必须以明确的后续服务生命周期启动同一隔离数据目录，不能把旧 unknown 换身份重放。部署健康不证明业务测试通过。

## 原生文件前置拒绝恢复

本修复仅修改 Assistant，无 schema 迁移。按本页静止实例原生退出切换流程打包、零写Check、排空退出、双包安装与独立回读。即使Observer未改也需显式提供当前已核验的包及摘要。安装后先检查精确包摘要、新进程与健康；旧 edit/write unknown 由 task_operation_reconcile 读取原生工具日志中的结构化错误码及同轮结束记录，不凭文件内容判成功。对账只记原调用 failed/noEffect 并保留审计，由原执行会话读取当前文件后按原授权补缺，不在部署脚本重放编辑或重复业务UAT部署。

Provider历史失败保留原貌；DSH默认5次请求重试不包含PI_AI_ERROR，插件针对已识别暂时故障另有3次持久恢复。原始结果、实际恢复次数、成功效果及未知效果分别核对。HTTP200不是业务成功，也不能单独证明可重试。

## 操作人确认原生失败终态

仅对当前operator技术申请，受信本机Web回复可携带 `nativeFailureResolutions: [{ operationId, expectedOperationDigest }]`。先向原reply路径加 `/check` 提交同一正文，返回 `writes:0`、精确原响应和正常turn结束序号及调查数；Check不能恢复会话或发API。核对原操作未知态、原isError、摘要、原会话排空及绑定只读调查后，正式reply才在同一事务内记录受信webActorId来源、结算全部指定操作为failed/partialEffectsPossible并回答申请。任何一项漂移或申请/任务版本变化整批回滚；不能由模型工具调用这条操作人路径，不记noEffect、成功或自动重放。独立读回原账previousObservation、operatorSourceId、proof和同会话新输入，不把技术结算当业务提交/部署批准。

## 旧Web补充重复话题收口

先部署精确包并核验入口和原任务/子执行均已排空。调用本机 `/runtime/task-topics/reconcile/check` 只读取得每项来源、目标、原任务、原decision/operation及摘要；只接受旧Web续办已applied且唯一原事项关系，不能按同标题猜测。确认这次四个重复话题只属于现场两任务后，使用同摘要和固定requestId调用正式reconcile。正式命令单次group事务写来源remove新版本、目标add新版本、closed/mergedInto及收据，不触发业务动作。

独立回读默认话题数、includeMerged档案、群消息唯一归属、原task refs与operation状态不变；旧话题revision1仍须可读。状态漂移或任务/执行活跃时停止apply，待原执行自然停稳再重新Check，不停止业务执行来强行合并。旧二进制不了解mergedInto，不应直接回退并重写该domain；保留兼容该字段的受控包。

## 授权连续性与等待说明核验

沿静止实例双包Check及正式切换部署，无schema迁移。恢复前读回当前申请、原始有权来源和任务版本；用户已经纠正重复审批时，走既有Web原申请reply记录纠正，不写SQLite、不自动批量关闭申请。恢复后核验原task/session及原execution新input包含相关授权和技术答复，既有unknown未被普通回复结算；以实际后续操作证明推进。敏感动作真实最终批准、后续撤销/暂停和共享环境限制仍保留。旧申请长文本仅改善展示，不改历史正文或授权事实。

一般“上线需批准”规则不能直接推导当前尚未批准：须与原用户已交办的同一UAT部署及后续纠正合并判断。部署修复后，沿当前原申请记录用户“部署到UAT就部署到UAT”的真实纠正，要求原执行完成实际发布及核验；不得仅改申请状态或以测试夹具代替真实推进。当前纠正不变更外部工作区规则，不新增Host关键词放行或自动批准机制。

本机完整冷启动可能超过两分钟；部署脚本对新进程端口就绪等待最多五分钟，退出排空仍为两分钟。若安装已核验且脚本只在启动等待超时，先回读原新PID、端口、profile和健康。该进程随后自然就绪时补记恢复证据即可，不重新安装或启动第二个实例；原超时证据保留。

## 本机桌面重启入口

`C:/Users/64554/Desktop/App/restart-dsh-web.ps1` 委托 `D:/dsh_home/launchers/restart-web.ps1`。当前启动器源码为 `scripts/restart-web.ps1`，更新时将该文件与 `docs/acceptance/task-session-runtime-repair/scripts/inspect-quiescent-ledger.mjs` 一起同步到上述 launchers 目录，并分别独立核对 SHA256。此入口仅管理既有本机 `DSH Web Local`、`D:/dsh_home` 和 `D:/baibu-agent/.dsh/task-sessions.sqlite`，不安装插件、不修改 profile 或初始化标记。

先运行桌面脚本 `-Check`：零写入、零信号，检查实例/端口、任务账本及原生回合；停止态验证数据库、初始化标记与原 owner 进程已退出，保留中断回合交正式 Host 恢复事务接管，不要求部署专用的全部 turn/end 前置证据。普通执行在停止态启动；运行态只允许静止账本，通过既有原生控制台退出脚本发送 CTRL+C，在同一有界等待内核对精确旧进程和既有子进程全部退出，再通过冷启动账本身份检查，恢复自启并启动。运行态存在未开始的任务领取也拒绝停机；检查后新进入的回合由 DSH 原生退出及正式 Host 恢复合同处理，不能把检查快照当原子排空。活动任务或未知启动中效果拒绝重启；unknown 历史操作不重放、不清账。

全健康要求一个新 DSH 进程拥有 3080/18998、health=ok、recoveryIssueCount=0、匿名 Web=401。冷启动等待最多五分钟；失败时保留现场，不强杀、不启动第二实例。原生退出阶段失败会保持自启禁用，须查明原因并沿原现场处理。此检查不代表真实钉钉业务验收通过。

启动完成以唯一进程双端口、可读健康响应、匿名 Web=401 及已配置入站就绪为准。health=degraded 时明确警告并返回实际 recoveryIssueCount，不冒充全健康；既有未知通知不会阻止报告服务已启动。此时查看 /state/recovery-issues 沿原记录核对，不重复重启或发送。
