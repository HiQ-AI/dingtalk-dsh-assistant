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

## 执行后端配置与核验

已经初始化的任务会话实例切换执行后端不需要新建数据库、迁移任务或重复本页历史清洁启动步骤。代码升级仍沿下文“已初始化实例更新核验”的受控部署流程；配置切换仅影响新建执行，不能迁移已经绑定的成员。

在插件配置页的既有 Agent 表单选择“执行后端”，沿原有唯一保存按钮提交。选项为 DSH 原生（默认）和交互式 Claude Code（Agent Teams，内测）。统筹会话仍为 DSH；选择 Claude 时，由 PTY 中的交互式 Lead 按需创建和调度原生队友，默认 in-process，不要求安装 tmux，也不为每个队友新开系统窗口。`GET /state/agent-config` 的 `executionBackend` 为 `dsh` 或 `claude-code`；未保存时读取 profile 中的 `taskSessions.executionBackend`，两者均缺省时读取 `dsh`，已保存值优先。保存后刷新回读，必要时在受控重启后再次核对。非法值应在写入任何配置前拒绝，保存失败保留页面草稿，不能只凭提示文字认定生效。

启用 CLI 前，在实际服务账号与服务 PATH 下用 `Get-Command claude` 和 `claude --version` 只读核对已安装的命令及版本，操作者按 CLI 自身入口完成登录。插件不自动安装、登录或迁移凭据，也不会因 CLI 不可用改用 DSH。CLI 使用自身默认模型，不接收 DSH 的 provider/model、推理深度、preset、工具或 Skill 注册表；`CLAUDE.md` 按 CLI 自身行为处理，不能认定 DSH 指引已同步。配置页保存成功不证明 CLI 已登录或模型可调用。须在已登录的实际服务环境做下列限定本地文件的实际验收。

- 新建隔离任务，核对新 execution 的 `executionBackend` 与配置一致；再次切换配置后续办原成员，原后端、executionId、会话身份与历史保持不变。缺少后端字段的旧成员继续使用 DSH，不能重建替身来完成切换。
- 两种后端均沿同一 Task 的按需执行团队、阶段报告、成员消息和资源互斥运行。实际读取 `outputs/<executionId>/round-<inputVersion>.md`；续办后旧轮文件不变，新轮文件包含新职责。CLI 受管事件在同目录 `claude-events.jsonl`，DSH 原生日志仍在任务的 `.dsh/sessions/`。路径展示不证明文件写入成功，文档告警须单独核对。
- 看板中 CLI 成员应显示 Claude Code 标签及原标题、状态、耗时，详情保留工作目录与文档/日志路径，没有“打开 DSH 会话”入口。DSH 成员原生入口仍可读取历史；不通过其他会话界面接管任务生命周期。
- 核对真实进程由 `spawnTerminal` 启动且不带 `-p`，CLI 版本至少 2.1.309（HTTP hook 失败必须阻断，并支持 `--system-prompt-snapshot off` 刷新续办职责提示）；Lead 的 `Agent` 回执必须是 `teammate_spawned`、in-process，并有原生团队身份。Lead/队友工具通过受管 HTTP hooks 进入 Host 当前身份、版本及 operation 准入；结构化 MCP 提交和匹配工具结果才是结果候选，终端文字不作凭证。允许 Lead 按需组队，禁止队友再次派生、跨团队 peer、后台命令、自定义 hooks 和其他 MCP，不使用跳过权限参数。成员文档位于 `outputs/<executionId>/round-<inputVersion>-lease-<leaseEpoch>/`；核对职责、消息/工具事件与关闭批准。新执行必须有 `claudeSessionMode: interactive-team-v1`；旧 headless 无标记记录须明确拒绝自动恢复，不能手改标记迁移。内部成员消息不构成新增业务授权，CLI 不因此继承 DSH 沙箱。
- 取消与恢复分别核对实际受管进程的退出证明、当前操作账及原绑定。没有 DSH 句柄、已经请求取消或 CLI 输出了结果都不能单独证明排空；不能证明时保留执行占位及应保留的资源锁。CLI `unknown` 保留原记录和保护，本版不走 DSH 原生日志自动对账，也不接受原生失败处理材料冒充 CLI 证据；不得重放原动作、换身份或手改账本清除未知效果。

上述检查分别保留配置回读、协议测试、真实 CLI 推理与产物证据。子进程协议夹具、页面测试或健康状态不能替代实际 CLI 登录、模型调用及业务交付验证；切换回 DSH 也只作用于新建执行。

## 开放前核验

- 用新 profile 启动，核对实际 workspace、dbPath、instanceId、epoch 和独立 domain；确认旧任务/授权/通知均不出现在新看板。
- 运行实际 Web 构建并加载官方 ClientModuleRegistry 产物；进一步在现场浏览器确认页面能打开。
- 触发监听 ready 回补，证明旧消息和无时间消息被隔离、旧通知发送次数为零；再发送一条边界后的新消息，确认任务、执行、实际 JSONL 都落到新根。
- 同一消息重放和进程重启后不得重复建任务或外发结论。核对两个执行会话、取消排空、需求更新及真实回复引用/@。
- 材料缓存和原生日志缓存的链接安全用例：Windows 使用不需额外权限的原生 directory junction 替换最终路径，核验重解析点被拒绝、外部原文件字节和目录不变；POSIX 使用 file symlink。Windows junction 通过不代表已验证文件 symlink；不具备文件 symlink 权限时，该类型仍属未验证，不能关闭安全限制换取通过。

## 已初始化实例更新核验

引用部署指令承接修复同时更新 Assistant 与 Observer，无 SQL schema 迁移。按本节原生双包流程先 `-Check`、排空、切换并独立核对包 SHA256、安装版本、新 PID 与健康。先只读核验 #313：原状态应为“待澄清”，结论为实际旧问题；原 91359ms 仅为已完成语义决策耗时，不能当部署耗时。新消息来源预约保留引用；旧预约从精确原版本的来源账读取引用，不从更新版本借信息。

原“缺少对象”澄清确由旧预约遗漏引用导致时，仅显式使用最新 GET `processingFacts.recovery` 中 `phase=coordination-context` 的原预约与 token；沿既有精确消息 retry API 提交当前 messageVersion 和 activeUnitRefs。该入口核验原来源引用、安排版本及无成员/日程/执行效果，原子推进 ledger fence、保留旧问题与已送达通知、将旧语义戳存历史，再在原安排重判；不复制消息、不重发旧澄清、不清未知效果、不重置失败预算。无候选或 CAS 拒绝须查当前事实，不用普通失败重试或直接改库。原任务若已经由后续来源承接相同部署，只关联观察，不重复重开、修订或派发。恢复后分别回读原消息的接纳结论、原任务当前目标/UAT2、原安排身份和通知发送次数；承接通过不代表 UAT2 已部署。仍缺业务条件的记录保留澄清，不能强行接纳。

模型目录读取使用 ctx.remote.session 时，客户端 inject 必须同时声明 remote 和 remote.session；只声明子门面会在真实 Cordis sibling 服务隔离下崩溃。部署后必须打开实际插件页核验，不能用普通对象上下文替身代替。

模型选择器统一修复只更新 Assistant，无 schema 迁移。按本节双包流程部署后刷新设置页，逐一打开默认处理、统筹、协调菜单，核对同一全提供方目录、搜索与分组，跨提供方选择保存后独立回读 provider/model。只打开菜单或更改草稿不应修改当前聊天会话；不要为验收发送真实模型请求或重放业务。继承推理深度保留独立复选框。原生组件未就绪应明确提示，不降级为插件自画菜单。

多事项回复范围说明仅更新 Assistant 的公共回复指引，无配置或数据迁移；沿下述已初始化实例规程更新。核对新消息包含两个独立事项时各条回复能区分具体问题，以及只处理或完成其中一部分时能说清是哪几项、其余进展有事实依据。回复语气应自然、表达可随上下文变化并符合真实进度，不以命中固定词句作为验收条件。保留各话题独立任务与通知身份；既有通知不改写、不重发。源码回归不代表已部署或真实模型与钉钉渠道验收通过。

模型冷却期间，明确分类为 `replan` 的 Web 需求变更会推进需求版本；普通提醒/事实澄清须声明 `preserve`，保留需求版本与原执行。分类缺失或冲突会拒绝，不默认修订。需求版本变化后，已失败的旧执行仍须在冷却到期后产生 `execution.provider.review`，只唤醒当前统筹，不自动执行旧输入。安装恢复修复后，回读原执行 `providerRecovery.reviewedAt`、复核事件的新旧需求版本，以及同一 executionId/sessionId 后续输入；不能只看任务短暂进入 running。`nextReviewAt` 已过期的记录会由既有恢复调度复核，不手改账、不重置预算，也不再追加一次上下文制造版本变化。若有活动业务执行，先等待自然排空，再按本页静止实例规程切换。

发信箱取消状态修复同时更新 Assistant 投影与 Observer，无通知生命周期迁移；按原生双包脚本部署。重载后核对待发送、发送中、待确认、已送达、已取消、异常六种短状态、一个筛选、四个默认列；原因/替代/撤回为消息辅助信息，内部 ID 默认折叠。订正导致未发送的 superseded 与有确定未发送证明的正式终止归已取消；需要人工核验及一般发送失败仍为异常。已送达/未知不被取消或替代关系覆盖，历史缺证保持待确认，已取消无重试计划。独立对比通知账原始记录、发送次数与回执，允许只读投影更新，不重发；UI 通过不代表未知通知已经送达。

协调工作看板更新 Assistant 与 Observer 两包，无数据迁移；沿本页既有原生双包规程更新，不重建数据库或重放协调输入。更新后只读核验 `/state/coordination-work` 的实体数与群组筛选、分页、改期去重、任务依赖及版本绑定完成证明；旧来源接口仍可查未接纳输入，但不应制造工作行。原失败提醒必须以“提醒发送失败”为主要结果，不能被 active、accepted 或 job completed 覆盖；暂停/取消后仍保留既有送达、失败和未知事实，后续触发与重试只按真实时间记录显示。发送许可前取消且没有许可、发送次数或回执的内部失败记录须显示取消，不冒称发送失败；既有真实失败与当前证明正式完成的任务仍须保留，取消结果通知不撤销任务完成。指令已接纳、任务已调度、业务正式完成与通知送达分别表达。接口不可用或刷新失败应明确提示，保留的同范围旧内容须标识可能过期。隔离 SQLite/HTTP 与最小宿主适配器浏览器验收不代表完整宿主、共享部署或真实钉钉渠道已通过；现场核验不得为制造状态而发送消息、重试通知或修改账本。

看板提示关闭修复仅修改 Observer，无数据迁移。原生部署脚本仍显式传入两包并校验摘要，Assistant 复用当前受信包。浏览器刷新后成功反馈应支持手动关闭且 5 秒消失；错误反馈支持手动关闭，恢复后清除，同一持续错误不因轮询重新出现。无需通过归档其他业务任务制造测试提示。

发信箱送达与替代关系修复更新 Assistant 与 Observer 两包，无数据库迁移；按下述原生脚本预检和部署。恢复后检查原已送达且被替代的记录仍显示已送达、替代关系单独保留，已送达筛选可见该记录，且不再显示等待替换通知送达后撤回。界面只展示送达确认时间 deliveredAt，缺失显示未记录；历史事实不补写、不重发。

普通代码更新保留同一数据库、初始化标记、instanceId、epoch 和原会话目录，不重复清洁启动。当前任务会话运行时没有旧 workflow maintenance 接口，不能直接使用依赖该接口的历史部署脚本。停机前须通过当前宿主的原生生命周期停止接纳并排空，确认原任务/执行/群会话及实际业务子进程已结束；不能仅凭一次 SQLite 快照声称原子排空。普通本地部署不备份历史副本。 从打包到安装后核验完成，部署所用源码检出必须保持冻结；后续开发不得并行修改该检出中的包源码。否则包虽未变化，逐文件源码检查也会中止部署。

本机静止实例使用 [原生退出切换脚本](../acceptance/task-session-runtime-repair/scripts/deploy-task-session-native.ps1)：显式传入持久 Assistant 与 Observer 两个包及各自摘要、精确旧 PID、当前 profile 摘要及本轮证据目录，先 `-Check`，通过后同参数执行。脚本先核验共享控制台仅包含精确计划任务进程树，再经 Windows CTRL+C 触发 DSH 原生 SIGINT disposal；等待旧进程退出、SQLite owner 释放、原生日志回合结束和实际子进程退出后，才沿官方 `dsh plugin --profile web add` 安装。不修改 profile，核验其原字节摘要并还原自启状态，经计划任务启动并回读。失败保留现场与阶段记录，不自动强制重启；不得将其用于活动业务执行或其他实例。此脚本只支持既有已配置的本机身份与路径，不承担迁移。 profile 声明本地 `file:` 目录宿主时，先核对声明与已安装宿主版本一致；漂移以 `DEPLOY_HOST_CONFIGURATION_DRIFT` 在停机前拒绝，普通代码部署不得隐式切换宿主。停机前以 profile 原生 CLI 的只读 `plugin --help` 验证依赖装配。安装失败保留停机现场，先核对原包/profile摘要、旧PID已退出、端口关闭与原生离线账本排空，再用同一配置声明的原生CLI接续原安装阶段；不要重新发信或重做原业务。

冷启动的完整 profile 模块图可能超过五分钟，原生脚本为同一新进程的双端口就绪保留十分钟有界等待；端口就绪后仍须核验健康与入站恢复。若报 `DEPLOY_NEW_PROCESS_NOT_READY`，不重跑安装或盲目重启：先读取原 failure/control/installed 收据、同一新 PID、双端口和健康；进程随后就绪时保留失败收据，另记独立回读结果。无端口或进程退出仍按失败处理，不能以延长等待掩盖异常。

账本预检按执行创建时绑定的后端读取证据：DSH 沿原 JSONL；Claude 读取自身 `outputs/<executionId>/claude-events.jsonl`，验证原 UUID、连续输入历史、版本/摘要/修订/租约、事件序号与最后排空记录，拒绝缺失、损坏、未知后端及链接路径。连续续办尚未领取时，仅在同租约、历史连续且最后已排空轮次精确匹配原输入、没有较新 start，并且当前为 queued 或已正式取消/失效时返回独立未启动证明；不恢复会话、不重放或结清 unknown。此证明仍只是停机前候选，实际退出和子进程排空须由正式部署流程另证。

恢复后核对包 SHA256、安装版本、新进程及健康，再分别核对收信箱、原通知及原任务。通知的原 `openTaskId` 查询 SUCCESS 后须读取精确原消息，确认消息 ID 与目标会话一致即可结清送达，不再以钉钉渲染后的正文或引用/@元数据作为该路径的硬门槛。该路径记录 `mentionVerification=unavailable`，仅证明送达，不声称正文、引用或 @ 已验证。无成功发送任务回执的历史匹配继续严格核对原正文、发送者、引用和 @。unknown 只沿原通知正常回读核验，不重发、不直接改 SQLite；独立确认原 receipt.messageId 与 sendAttemptCount 未增加。

若原通知只因顶层有序列表的 `1./2./3.` 在分段回读时变为 `1./1./1.` 而停留 unknown，安装列表回读修复后交由既有 notification.reconcile 正式结清；不手改 SQLite、正文或发送回执，不调用发送/重试发送接口。独立回读原 notificationId、原 messageId、delivered、sendAttemptCount 仍为 1，再核对恢复告警消失及健康状态。代码围栏、非连续编号、列表顺序或正文数字变化继续拒绝。

若新提醒因旧版本把超长内部 ID 直接作为 DWS uuid 而被平台明确拒绝，升级后仅在完整持久负回执、许可、长度与唯一尝试均匹配且无 ACK/receipt 时，自动沿 notification.reconcile 结清为 failed；这是失败确认，不是送达或重发。按原生排空流程保留原 unknown，启动后独立核对 notification/occurrence 失败、sendAttemptCount 仍为 1、负回执保留和健康状态。新发送使用有界外部键；验收必须重新发出获授权的新测试指令，不直接重放旧通知。

启动时 active、已排空、lastDecision=wait、无 question 且有 unknown 操作的任务，按相关运行模块摘要和当前需求/控制版本补一次 `runtime.updated` 唤醒。重复定时恢复或同代码重启不再补发；暂停、取消、人工问题等待和仍有执行的任务不适用。Owner 沿原任务调查并使用 `task_operation_reconcile` 核验，未知操作未被证明前不能放行原动作。

批量跟进原任务的决策修复只更新 Assistant，无数据迁移。按本页原生部署流程应用后，新协调会话将分页读取轻量任务目录，并分别续办已查明的原 Task。已接纳的新建总任务不会自动撤销或重路由；处理旧现场前先核对其已发生效果，防止与原任务重复修改、发信或提测。部署验收应独立确认目录分页与原任务身份延续，测试中的模拟动作不代表现场任务已重开。

交互 Claude 的初始输入与运行设置经 CLI 参数传入；Windows 命令行长度上限仍适用，超大上下文尚未验证。启动失败按原失败回执处理，不截断输入、不改派为 DSH。

## 回退

### 人工介入与原生能力更新

本次无 schema 迁移，仍沿原生排空双包部署。技术申请缺省 operator，Web 人工介入保持原接口；私聊收件人来自当前 DWS profile 的认证 user_id，不使用需求提出人或人工填写的任务参数。新版将既有仍有效的待答技术申请登记到私聊通知账；已送达旧群消息保留历史，不重发。停用 DWS 外发或无登录身份时仅保留 Web，不回退群询问。

部署后独立读取 authorizations 的 audience/notification，核验私聊真实 messageId、会话、发送者及引用答复，再核验原 Task/session 恢复。原生调用不再挂插件文件边界、跨操作 unknown 全局门禁或合成全局写锁；沿当前 preset、danger-full-access、原生 sandbox/approval。核验 gh 查询和原任务日志读取，旧 unknown 记录及原业务完成门禁保持，不手改账或将历史未知伪装为成功。正文仅去除与受信原消息相同的前置重复引文，其他证据引文保留。

### 历史自身回声阻断话题任务更新

群话题续办的 `TASK_TOPIC_AUTHENTICATED_SOURCE_REQUIRED` 须先核对原动作 basis、已准入消息作者、任务所有者和写入收据。同群不同成员的明确补充或重开不按最初发起人过滤；仍要求同群真实来源，Web 仅允许已配置身份，内部/通知来源不得代替用户授权。补充按显式分类处理：`preserve` 保留原执行，`replan` 修订需求并使旧执行失效。requester 人工答复仍限原请求者，其他成员补充不能代答；明确目标或授权变更优先于原作者的普通答复路径。群话题 `task-cancel` 动作仍只接纳任务原所有者或配置的 `ownerActorId`，同群续办规则不扩大取消权限。安装修复后通过下述原消息 retry 入口恢复写入前拒绝，保留原 task/session/operation；版本变化、已应用或未知效果按既有恢复门禁拒绝或对账，不手改状态，不另建任务。

`TASK_TOPIC_SOURCE_VERSION_MISSING` 先对照固定话题历史与动态来源账：已核验的自身通知没有用户准入来源是正常情况，真实消息缺失则必须保持拒绝，不能补造授权。新版任务更新排除通知账/可信发送身份核验的自身回声，并在所有动作落账后才准备话题回复。

更新仍沿本页原生排空与精确双包部署。对已确认属于该错误、动作尚未应用且任务版本仍当前的消息，通过现有 `POST /config/groups/<groupId>/messages/<messageId>/retry` 显式重试；入口复用原动作恢复门禁。旧版提前发送的回复可能已投影为 `task-notification` 来源，新版沿稳定 outboundId 核验正文、决策及引用身份，复用原生通知收据并回读当前态；不拿旧 prepared 收据覆盖 delivered 缓存。若旧恢复已停在 `outbox_identity_duplicate`，且全部动作已应用、失败点是该回复、原发件箱身份存在，同一重试入口仅恢复回复收口。既有已送达回复不重发，原任务/会话和完成执行结果保留。部署后独立回读话题 processedRevision、动作状态、人工请求、原任务新增来源及原生会话承接。其他未知效果和版本冲突不在本恢复范围。

新旧服务不得并行消费并执行同一群消息。需要回退先停新监听/外发与实际执行，保留新数据库、初始化标记、日志及真实外部效果证据，再按审阅后的旧实例配置恢复。清洁启动没有把新任务转换成旧工作流，不能恢复旧服务后自动重放新任务。旧数据的可恢复隔离与删除授权是两回事，不执行永久清理。

任务统筹只保留本轮任务管理、模型内容和可信 preset 的 skill/read/read_image，具体业务工具交给动态执行会话；每次恢复重新装配边界。升级前由统筹直接产生的历史效果仍须按原记录对账，不迁移或重放。部署后检查统筹继承目录无 Shell/写入/搜索工具，强行调用和晚注册替换被拒绝，再验证单执行委派、证据读取及完成路径；readOnly/readbackOperationId仅用于关联原操作调查与对账材料，不用工具种类代替事实核验。原生权限、来源版本、真实生命周期及未决效果账继续按实际状态判断。即使Observer源码没有变，也必须显式提供当前已核验的ObserverPackage及摘要：官方安装会重新解析profile既有overrides，单独安装Assistant可能回退Observer。两个包均经源码/安装读回核验。

统筹更新核验需区分新增Host输入、保留的旧Host内容与整个模型请求。检查原生surface仅保留当前Host快照，旧快照及旧版历史标记不再占模型消息，原审计输入仍存在，执行previousExecutions不递归。目录里的终态不是业务验收证据，须沿resultRef读取原结果。对模型过载查看本lease的turn/end：临时过载保留wake，按现有retryIntervalMs退避后续办同会话，不把其写为业务blocked；旧版误blocked仅凭原生日志精确识别恢复。看板中统筹等待尚在执行的小目标仍为执行中。

阶段唤醒更新无schema迁移，按本页静止实例双包流程部署。普通operation.settle仅在原绑定完全匹配、执行仍运行且未排空/取消/恢复/修订失效时省略统筹唤醒；执行自己消费真实成功/失败。unknown、cancelled、对账、独立操作、迟到结果、阶段成果、执行结束和用户输入仍唤醒。验证时比较实际wake账与统筹回合数，不能仅断言工具返回成功。现场已等待真实人工决定时保持原请求，不为测试制造一次无意义统筹回合；可用精确原生输入对安装包做只读投影复验。此修复不删除已有会话历史，正常历史仍沿原生压缩处理。

阶段成果核验同时检查原报告 evidence/activity 经落账、统筹输入与时间轴投影后仍可读。报告 activity 表示报告时开始的活动；续办保留的旧 stageProgress 只能作为历史证据，按 inputVersion/leaseEpoch 及需求/控制版本核对，不当作本轮正在执行。看板在现有成果区展示依据和“报告时活动”，不把执行报告标成独立验收通过。没有活动的旧报告不猜测补齐。

人工介入核验：待答请求在/state/authorizations返回taskSessionRequest=true、status=waiting-reply，任务归等待中；POST /tasks/:taskId/human-requests/:requestId/reply只接纳本机受信Web请求，body含幂等requestId、reply及expectedRequirementRevision/expectedControlRevision。原文保留真实配置webActorId，旧版本/已答/非当前请求拒绝，成功后原task/session继续。修订或终态将旧申请superseded；不得通过手改账或伪造答复绕过边界。

群业务确认更新无新配置和数据表，沿本页已初始化实例更新流程。隔离核验 A 交办、B 回答当前 requester 问题：同任务新群来源应先进入只读 humanReview，核对完整条件后保存 resolution，再由下一 human.responded 回合恢复；解除前及解除后本轮均不能委派、反馈或完成。另验无关内容、旧消息、跨群来源、重复事件、operator 问题、执行结果与定时巡检均不误解除，模型失败/重启不吞候选，已判断为不足的来源不循环唤醒。原 task/session、执行身份和既有完成效果应保持。业务角色与回答充分性仍需核对模型的实际决定，Host 来源门禁测试不能代替该判断。升级不会自动重评旧 supplement 或补造历史答复；需要处理的历史任务先核对原消息及当前问题，再通过正常接纳入口补充，禁止直接改账。完整协议见 [人工介入 API](../api/task-session-human-requests.md#群聊业务答复核对)。

进度巡检核验：execution.progressReview.checkedAt为持久上次检查时间，running当前版本到期600000毫秒后由既有recovery tick读取原生日志；wake.kind=execution.progress.review。统筹未调用task_execution_progress就提交会收到TASK_EXECUTION_PROGRESS_REVIEW_REQUIRED纠正；该工具现在返回本轮document引用，统筹须用原生read读文档后判断，日常不再返回日志摘录。缺文件、身份/输入不匹配或无阶段报告如实呈现，不能仅查状态宣布推进。巡检不发额外群进度消息，不清unknown效果。

协作质量更新沿本页现有部署流程，无新配置和数据库迁移。执行团队按 Task 按需拆分和复用，不设最低人数或固定总人数上限。核验零执行、单执行、双执行在成果齐备且排空后均可 complete，第11名及更多成员可正常登记；依赖未齐的工作延后派发，简单任务不凑人数。现有并发容量、同一执行单飞、资源互斥和未知效果/排空完成条件保持生效；人数不限不等于无限并发。历史成员继续按原身份读取和续办，不删除或重建。检查 objective/context 是否明确每成员本轮职责、任务、输入、负责范围、前置、交付物及验收方法，resourceKeys 是否对应真实冲突资源。独立就绪目标应在同轮登记后再 wait；高风险自证需固定产物版本后补独立只读核验，不能用重做外部写入来补证。隔离模型复验入口见 `docs/acceptance/task-collaboration-quality/scripts/evaluate-model.mjs`，结果与语义审阅记入同特性轮次；不能以提示词存在或会话数量增加代替行为验证。

每轮文档核验：在隔离任务独立读取 `tasks/<taskId>/outputs/<executionId>/round-<inputVersion>.md`，确认身份、职责、首次阶段报告 plan、进展与最终结果相符。同轮报告可以更新文件；原 execution 续办后须产生下一 inputVersion 文件，独立比较旧文件 SHA256，确认后续报告和重启未改变旧轮。不能拿旧阶段报告当成本轮进度。文档属于可读投影，原账本保留恢复权威；文档写入异常会出技术告警，先修复真实路径/权限，不手工覆盖身份头或删除历史轮次。已提交账本回执不会因文档错误丢失，严格文档读取与下一轮切换仍须成功。此升级不补造升级前已丢失完整输入的历史文档。

升级后在隔离任务确认执行工具目录存在 `execution_team_read` 和 `execution_send_message`。用同 Task 当前成员身份及目标 inputVersion 发送一条必要消息，独立回读 feedback 的 sourceExecutionId、sourceInputVersion、inputVersion、consumedAt 和原生日志 sequence；队列接收、模型步骤消费与业务处理分别核验。重复 key 不重复投递，跨 Task、旧输入版本或旧发送租约拒绝；已终态目标返回 recipient_finished，不启动新回合。续办后的旧 peer 消息只保留历史，不阻塞新轮次；统筹原有补充语义不变。只需对依赖就绪、接口/证据交接和具体冲突发定向消息，无新事实不反复发送。此检查不操作或重放现场任务。

统筹方向判断核验：除检查读取调用外，核对巡检决定是否把最新整体目标、受托目标、范围及验收条件与实际行动对照，说明当前进展和下一必要结果。首次出现具体偏离就应通过原executionId反馈，不以重复错误为触发条件；确认偏离后仅复述进展并wait不算有效纠偏。跟进时独立核对反馈后的真实动作/产物，received或modelStepEnteredAt不能证明落实。必要验证、正常等待、证据不足和真实人工等待分别验证，不以一律发反馈为通过标准；本项不改变原人工等待/暂停机制。

能力/配置问答还须覆盖 `execution.result` 唤醒：读取当前版本实际结果，检查原问题是否已经可答，不把执行建议的附加排查当成必做项。用已核实版本的常量配置场景验证直接答复，用运行中多余调查场景验证原执行纠偏；以未绑定运行版本、真实读取配置但过滤未知、用户明确要求完整现场排障作为反例，防止为了简短而提前收口。每例核对实际结论、因果、必要下一步及是否产生多余人工申请，不以 complete/wait 或关键词单独判定。复验沿用下述模型脚本，本项没有数据迁移，也不重放原任务；隔离验证不能代替部署后的真实行为观察。

行为复验沿用 `docs/acceptance/task-progress-steering/scripts/evaluate-model.mjs`，使用完整的原生测试 profile 和当前已授权模型连接，外部业务工具保持禁止。先核对 `task_execution_read` 等合成响应符合当前真实合同；原生工具输出校验错误、模型超时或测试跳过均不算通过。人工申请与取消只连接合成出口，保留第一次选择，不能靠提前拒绝错误动作后让模型自纠正来判 PASS。逐例审阅反馈与完整决定，区别“已发出纠偏”和“执行已落实”，并从原生日志回读调用顺序、summary、evidence、limitations。此次调查、受管登录、错误截图、正常等待及组合交付的情境和结果见 [统一回复与复盘改进记录](../acceptance/unified-reply-validation/goal.md)。

决定留存核验：通过 `GET /state/tasks/:taskId/decisions?limit=20` 读取历次完整决定，按 nextBefore 继续分页。至少核对连续两轮、同命令重试、人工介入、完成和重启后原记录不变；最新 lastDecision 更新不能删除旧说明。历史复用 dynamic_receipts 的不可覆盖命令收据，新版为 taskDecision.taskId 建部分索引，不增加历史数组或定时补录；首次升级建索引可能增加启动耗时。升级前原日志/收据保留，接口只列具备 taskDecision 结构的记录，不能据空列表声称历史从未决定过。

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

原生子 Agent 日志绑定修复无 schema 迁移。沿本文静止实例双包 Check、原生退出、安装及回读部署；新子会话先验证存活父 Agent，再登记到同一任务。历史 `TASK_SESSION_BINDING_REQUIRED` 不按错误字符串自动结算：原调用已有 isError、正常 turn/end、排空和绑定只读调查时，使用下述 operator 检查/回复路径。旧 unknown 及可能部分效果保留，不重放原审查或已成功部署。部署前若报 `DEPLOY_NATIVE_TURN_NOT_ENDED`，核验对应原生回合并等其自然排空，不能靠修改账本强行通过。

仅对当前operator技术申请，受信本机Web回复可携带 `nativeFailureResolutions: [{ operationId, expectedOperationDigest }]`。先向原reply路径加 `/check` 提交同一正文，返回 `writes:0`、精确原响应和正常turn结束序号及调查数；Check不能恢复会话或发API。核对原操作未知态、原isError、摘要、原会话排空及绑定只读调查后，正式reply才在同一事务内记录受信webActorId来源、结算全部指定操作为failed/partialEffectsPossible并回答申请。任何一项漂移或申请/任务版本变化整批回滚；不能由模型工具调用这条操作人路径，不记noEffect、成功或自动重放。独立读回原账previousObservation、operatorSourceId、proof和同会话新输入，不把技术结算当业务提交/部署批准。

## 旧Web补充重复话题收口

先部署精确包并核验入口和原任务/子执行均已排空。调用本机 `/runtime/task-topics/reconcile/check` 只读取得每项来源、目标、原任务、原decision/operation及摘要；只接受旧Web续办已applied且唯一原事项关系，不能按同标题猜测。确认这次四个重复话题只属于现场两任务后，使用同摘要和固定requestId调用正式reconcile。正式命令单次group事务写来源remove新版本、目标add新版本、closed/mergedInto及收据，不触发业务动作。

独立回读默认话题数、includeMerged档案、群消息唯一归属、原task refs与operation状态不变；旧话题revision1仍须可读。状态漂移或任务/执行活跃时停止apply，待原执行自然停稳再重新Check，不停止业务执行来强行合并。旧二进制不了解mergedInto，不应直接回退并重写该domain；保留兼容该字段的受控包。

## 授权连续性与等待说明核验

沿静止实例双包Check及正式切换部署，无schema迁移。恢复前读回当前申请、原始有权来源和任务版本；用户已经纠正重复审批时，走既有Web原申请reply记录纠正，不写SQLite、不自动批量关闭申请。恢复后核验原task/session及原execution新input包含相关授权和技术答复，既有unknown未被普通回复结算；以实际后续操作证明推进。敏感动作真实最终批准、后续撤销/暂停和共享环境限制仍保留。旧申请长文本仅改善展示，不改历史正文或授权事实。

一般“上线需批准”规则不能直接推导当前尚未批准：须与原用户已交办的同一UAT部署及后续纠正合并判断。部署修复后，沿当前原申请记录用户“部署到UAT就部署到UAT”的真实纠正，要求原执行完成实际发布及核验；不得仅改申请状态或以测试夹具代替真实推进。当前纠正不变更外部工作区规则，不新增Host关键词放行或自动批准机制。

本机完整冷启动可能超过两分钟；部署脚本对新进程端口就绪等待最多五分钟，退出排空仍为两分钟。若安装已核验且脚本只在启动等待超时，先回读原新PID、端口、profile和健康。该进程随后自然就绪时补记恢复证据即可，不重新安装或启动第二个实例；原超时证据保留。

## Windows 精确 Task 沙箱目录修复

仅当 Windows ACL sandbox 在已授权 Task 根目录报 `SetNamedSecurityInfoW` / `grantWrite` Win32 5，且零写入检查同时证明当前 Host 用户是该根 Owner、`WRITE_DAC=true`、`WRITE_OWNER=false` 时，使用 `docs/acceptance/task-coordination-v1.3/scripts/repair-task-sandbox-acl.ps1`。这不是通用 ACL 管理工具，也不替代业务授权或 sandbox 边界。

先执行零副作用检查；它只以 `OPEN_EXISTING` 核验真实 `WRITE_DAC`/`WRITE_OWNER`，不会创建证据或修改权限：

```powershell
& docs/acceptance/task-coordination-v1.3/scripts/repair-task-sandbox-acl.ps1 -Check
```

只有经用户批准指定根目录后，才执行同一脚本的 `-Execute` 并传入已存在、持久且位于目标根目录之外的证据目录。脚本默认仅接受本轮固定的 A/B/C Task 根 ID；可用 `-TaskId` 缩至单个根。正式团队产物根使用互斥的 `-CoordinationId coordination-f1767af593d66d5eabe73d31dfbc9a30`，只解析 `D:/baibu-agent/tasks/<该固定协调ID>/outputs`，不接受任意 Path；先由 Host 可信 scope 解析器创建空目录并核对绝对路径，再以同模式 Check、核准、Execute，不能用业务产物创建代替目录准备。它为当前 Owner 添加一条**不继承**的 `WRITE_OWNER` Allow ACE，不修改父目录、Owner、SACL、Low label 或既有 deny ACE；DACL 写入前后保存 SDDL 证据，并独立复验有效权限、Owner、SACL、DACL 和最终全目标集合。执行期间不得有任何并发 ACL writer（包括 sandbox `grantWrite`）；脚本不是原子 CAS，发现变化即停止，不自动重试。

```powershell
& docs/acceptance/task-coordination-v1.3/scripts/repair-task-sandbox-acl.ps1 `
  -Execute -TaskId '<批准的固定 Task ID>' `
  -EvidenceDirectory '<已存在的持久证据目录>'
```

不得使用 `runas`/UAC、`icacls` 手改、递归继承、删除 deny、关闭 sandbox 或扩大到 `tasks` 父目录。修复后沿原 Task 的受支持恢复路径重试；仅权限探针通过不代表 native `grantWrite`、业务文件写入或协调依赖已通过，须分别回读原工具结果和账本事实。

## 正式团队产物绑定

单 Task 团队沿用 `tasks/<taskId>/outputs`。跨 Task 协调团队的唯一业务产物容器为 Host 根据稳定 coordinationId 计算的 `tasks/<coordinationId>/outputs`，不是新增总 Task；原 Task 材料、内部日志、会话 header.cwd 与 Host 阅读投影保持原址。插件从唯一有效协调成员关系解析该目录，不接受模型提供的任意根；多协调归属、重复 Task 成员及周期实例目前拒绝自动绑定，不能猜测第一项或最近安排。

部署此功能前，先使用 `scripts/sandbox-artifact-policy.mjs` 为精确原生 `dsh-sandbox-policy` 制作并核验支持 `bindArtifactRoot(session,{ownerId,artifactRoot})` 的补丁包，按其 Check/Apply/Verify 流程固定 tgz 摘要与 profile override，再按本页正常排空部署插件。仅安装 Assistant 不会补齐原生 API；缺少 API 时插件明确拒绝进入绑定任务，不退回宽权限。不得直接改 node_modules、全局替换 policy.resolve、修改旧 session.header 或切换 danger-full-access。

原生绑定把 `sandbox/mode` 携带完整产物绑定的 事件持久化于各原会话；相同绑定幂等、不同绑定拒绝，每次解析重验目录链。Owner 与 DSH 执行通过同一 API 绑定共同产物根，shell 与 native FS 使用同一策略并拒绝根外业务写；平台临时区域维持原生语义，不作为业务产物目录。绑定会话拒绝模型请求 full-access 绕过。外部执行后端不能据此自动视为已受原生策略约束，须独立支持或拒绝，不能静默放行。

核验需同时实跑根内 native write 与 shell 写入、另一个团队及原 cwd 的根外拒绝、跨 Task 原生 read、持久重启后同绑定、旧 header.cwd 不变；再验证原协调链的正式完成事件自然释放后继。原路径要求发生冲突时通过正式技术恢复说明明确纠正，不能仅口头通知而假称冻结需求已经重写，不能手改 Task 或完成账。原生能力证据不等于真实群业务验收通过。

## 本机桌面重启入口

`C:/Users/64554/Desktop/App/restart-dsh-web.ps1` 委托 `D:/dsh_home/launchers/restart-web.ps1`。当前启动器源码为 `scripts/restart-web.ps1`，更新时将该文件与 `docs/acceptance/task-session-runtime-repair/scripts/inspect-quiescent-ledger.mjs` 一起同步到上述 launchers 目录，并分别独立核对 SHA256。此入口仅管理既有本机 `DSH Web Local`、`D:/dsh_home` 和 `D:/baibu-agent/.dsh/task-sessions.sqlite`，不安装插件、不修改 profile 或初始化标记。

包含 Claude 执行的版本必须同步支持该后端日志的账本检查器；只更新插件包不会更新 launchers 副本。检查器仅依赖 Node 标准库，复制后不从仓库导入适配器，也不为核验启动 CLI。

先运行桌面脚本 `-Check`：零写入、零信号，检查实例/端口、任务账本及原生回合；停止态验证数据库、初始化标记与原 owner 进程已退出，保留中断回合交正式 Host 恢复事务接管，不要求部署专用的全部 turn/end 前置证据。普通执行在停止态启动；运行态只允许静止账本，通过既有原生控制台退出脚本发送 CTRL+C，在同一有界等待内核对精确旧进程和既有子进程全部退出，再通过冷启动账本身份检查，恢复自启并启动。运行态存在未开始的任务领取也拒绝停机；检查后新进入的回合由 DSH 原生退出及正式 Host 恢复合同处理，不能把检查快照当原子排空。活动任务或未知启动中效果拒绝重启；unknown 历史操作不重放、不清账。

全健康要求一个新 DSH 进程拥有 3080/18998、health=ok、recoveryIssueCount=0、匿名 Web=401。冷启动等待最多五分钟；失败时保留现场，不强杀、不启动第二实例。原生退出阶段失败会保持自启禁用，须查明原因并沿原现场处理。此检查不代表真实钉钉业务验收通过。

启动完成以唯一进程双端口、可读健康响应、匿名 Web=401 及已配置入站就绪为准。health=degraded 时明确警告并返回实际 recoveryIssueCount，不冒充全健康；既有未知通知不会阻止报告服务已启动。此时查看 /state/recovery-issues 沿原记录核对，不重复重启或发送。


## 协调启动失败补偿与新版预设

DSH新版不再支持subagent配置的toolFilter。当前配置中仅拒绝4个schedule工具的6处旧字段，用 `docs/acceptance/coordination-startup-recovery/scripts/repair-subagent-preset.mjs --check <profile绝对路径> <原SHA256>` 零写校验，再以同参数 `--apply` 原子应用；工具逐项验证YAML语义仅删除已知字段，不接受其他工具限制或范围变化。先实跑当前原生schedule插件：4个工具均对delegated child返回subagent_session，调度服务调用为0，才能移除旧配置；不能靠删限制让预设启动。

修复包沿本页已初始化实例原生部署规程切换，原通知不重发、原消息不重新发送。协调启动失败保持原请求ID和来源版本，持久化failurePhase/startupAttempt/nextRetryAt，恢复扫描先检查当前preset健康再接回；最高5分钟退避，重启不清除。历史仅attempt0且无已派发messageId的失败可恢复，普通协议耗尽或已有输入不自动接回。持久消息故障进入健康告警直到真正解决。

部署后分别回读原消息routingStatus、原coordinationRequest状态与resumeEpoch、关联Topic/Task及真实会话输入。原消息开始处理不代表其业务PR已修改或UAT提测完成；按原任务继续交付并保留未知效果保护。

原生部署启动回读在双端口就绪后，最多等待60秒实际DWS就绪（inboundProcessing与dwsBridge.healthy）；不能把首次健康快照的初始化中状态误判为安装失败。超时保留原阶段证据，先独立查实际进程和渠道；不要重复安装或强制重启。

## 资源互斥运行检查

沿已初始化实例的原生部署脚本先 `-Check`，确认会话及在途操作静止后切换。已有 `resourceKeys` 非空且仍运行或有未结操作的旧执行没有执行级锁，启动会报告 `DYNAMIC_EXECUTION_RESOURCE_UNGUARDED`；先沿原实例排空或对账，不直接补写锁、不清库，也不推定过去已受保护。新增执行复用现有资源表，无 schema 迁移。

部署后用隔离账本核验同资源等待、异资源并行、全部操作终态后自动提升，再独立回读已安装模块与进程健康。正式任务从执行查询或 `task_execution_read.resources` 读取 `held/waiting`、`keys` 与 `blocking`；queued 仅表示已接收。等待不应产生失败告警或反复领取。取消、暂停、修订仅能结清尚未启动的操作，后台 job 和 unknown 继续保留原锁，沿原操作核验终态后自动释放。不要通过换任务、换键、过期抢锁或直接改 SQLite 绕过阻塞。

统筹应在派发前声明本阶段全部共享资源，同一环境使用一致键名；续办省略资源键保留原集合。需要改变集合时等原执行与效果排空，再开始下一阶段。执行中新增未声明资源会拒绝，避免持有部分资源后循环等待。本合同只约束同一控制库内已声明资源的执行，不替代外部平台跨实例并发控制。

执行会话自身使用 `execution_resources_read {}`；它只接受空参数，由 Host 固定绑定 taskId、executionId、sessionId 和版本。回执含 inputVersion、leaseEpoch 及 `resources`，核对 `held` 和 `holder=execution:<executionId>`，续办或恢复后重新读取。读取不会产生 operation 或发送反馈，不必为了取得持锁证明再打断执行。原有方向纠偏和新输入检查仍适用；当前观察不保证后续任意时刻仍持锁。已停止/暂停或版本失效会拒绝，不能拿旧证明绕过控制状态。

该工具需要安装包含此实现的 Assistant 并在当前执行工具目录中实际可见；仅更新个人 skill 不会给旧 Host 增加工具。能力缺失时由统筹沿现有 `task_execution_read` 核对并记录版本缺口，不猜造调用或查询内部 SQLite。定向验证使用隔离实例的 `test/task-execution-resources-native.test.js`，核验同会话续办后版本/资源更新、未知参数被拒绝及无外部操作；不能将其当作正式实例已升级。

本机原任务重开入口随 Assistant 更新，无 schema 迁移。部署后通过受信 `/tasks/:taskId/reopen` 接纳带需求/控制版本的增量；核验原任务与会话身份、runSequence、来源记录和幂等收据，不直接改库。总任务先核对既有效果并取消其后续执行，再交回原事项。

## 原生编辑参数拒绝对账

原生 edit 的空路径、空匹配串及新旧内容相同属于写入前参数拒绝。仅在原调用参数、精确错误回执、任务身份和正常回合终态全部核对且执行排空后，对账为 failed/noEffect；不重放编辑。IO、权限、取消和其他歧义错误继续保持 unknown。
部署沿 task-session-clean-start.md 的静止实例原生双包脚本切换，无 schema 迁移；恢复后回读原 operation 终态及原 Owner 的完成状态，保留旧 unknown 观察和原 PR，不重新执行提交推送。

### 本地 PTY 生命周期补丁双包

交互式 Claude 后端需要修复后的 PTY 实现。沿同一原生退出切换脚本额外传入 `-PtyUpgradeProposal <绝对JSON路径>`；此参数仅允许 `@deepseek-ai/dsh-subprocess-local@0.2.1-rc.2.pty.2` 与 `node-pty@1.2.0-beta.15.dsh.2` 两个包，不切换整个宿主。先将构建包放入 `D:/dsh_home/packages/<本轮提交>/` 等持久目录，不以临时工作树路径作为安装依赖。R30 候选使用新的版本与目录，禁止覆盖旧 `pty.1` / `dsh.1` 包及其持久证据；旧包不满足本次退出码顺序修复门禁。

提案字段为 `schemaVersion: 1`、当前 profile `package.json` 的 `expectedPackageJsonSha256` 和恰好两项 `packages`；每项包含 `name`、`version`、绝对 `.tgz` 的 `path`、`sha256` 及 `files`（相对路径到 SHA256 的映射）。subprocess-local 必须核对 `lib/index.js`；node-pty 必须核对 `lib/windowsPtyAgent.js`、`lib/windowsTerminal.js` 和 `lib/unixTerminal.js`。helper 会读取压缩包中的名称、版本、依赖和关键字节，不能只凭提案声称正确。

`-Check` 调用 `scripts/pty-package-upgrade.mjs check`，零写核对两包与当前 manifest。实际执行在原进程、子进程和账本排空后再次做 manifest CAS，仅更新 `pnpm.overrides` 的这两个精确键，保留其他依赖与 overrides，并把前后 manifest SHA 写入 `pty-manifest-applied.json`。随后沿原官方 `plugin add` 安装；不直接编辑安装后的 node_modules。

安装后 `verify` 从实际 `dsh-base` 消费者解析 subprocess-local，再从该 provider 解析 node-pty，核对实际安装版本、关键文件字节与原 tgz 摘要，结果写入 `pty-installed.json`；仅根 node_modules 存在正确包不算通过。原 `cordis.patch.yml` 摘要保持不变，普通部署不传该参数。任一步失败保留停机状态与阶段证据，不以部分安装启动实例，也不自动回退或全量升级宿主。

## 团队统一业务产物根

同一协调团队的正式业务产物根为 <Agent工作区>/tasks/<coordinationId>/outputs，Owner和DSH执行成员共用，所有业务产物只写此处。原Task的cwd/header/session/log/Host执行阅读文档保持原址；不要通过改旧session.cwd、junction、分散fixture、额外docs目录或关闭沙箱恢复。当前外部CLI执行后端不承载该新scope，明确拒绝而非自动放宽。

所需原生 policy 扩展为本地精确包 `@deepseek-ai/dsh-sandbox-policy@0.2.1-rc.2.artifact.2`，再生成配方 `node scripts/sandbox-artifact-policy.mjs build <原生 rc.2 包绝对目录> <新空目标目录>`，只接受已审阅原入口 SHA。补丁通过持久 `sandbox/mode` 携带完整产物绑定的 原生投影保留 root 绑定，不改共享 service 方法；FS 与 shell 读取同一 resolve 结果，绑定会话禁止 danger 模式，根内写成功、根外拒绝必须实跑。

沿本页原生双包部署脚本增加 -ArtifactPolicyProposal <绝对JSON路径>，与PTY补丁模式互斥。提案只含schemaVersion1、固定name/version、当前profile package.json的expectedManifestSha256、持久packagePath/packageSha256/entrySha256。先 -Check 零写/零信号，正式执行仅在原PID/子进程/账本原生排空后CAS增加这一个原生包的直接file依赖与pnpm.overrides；保留其他依赖/overrides/profile patch，使用官方plugin add安装，不直接编辑node_modules。启动前verify从真实dsh-base消费者解析policy并核版本/入口字节；任一步失败保留阶段，不启动部分安装或重发历史消息。

旧链技术路径纠正沿原 Task operator 申请 `/tasks/:id/human-requests/:request/reply/check` 提交与正式 reply 完全相同正文，添加 `artifactScopeCorrection: {coordinationId, expectedRevision, reason}`；不得提交任意 artifactRoot。Check 返回 writes=0 及 Host 派生正式根。正式 reply 同事务记录受信 webActorId 纠正来源与 coordination 历史，旧 requirement/control/context/run、成员依赖、hold 和完成事实保持；B/C 在自然启动时读相同纠正来源。不得用该入口人工完成 Task 或调用后继启动。


## 协调调度关系只读升级

A 正式完成后调度 B 的关系投影及任务页前置等待说明同时修改 Assistant 与 Observer，无 schema 迁移，不重建业务库、不重放触发或通知。沿用本页原生双包 Check、排空、退出、安装和独立回读流程；部署核对包 SHA/版本、profile、新旧 PID、3080/18998、健康、入站与自启恢复后，再用既有真实关系只读验收。协调页只表达等待前置、待下发、下发成功/失败及真实原因，B 的执行或完成状态仅在 B 任务页；不能据 B active/fulfilled 猜测协调成功。任务页前置等待须可点击具体前置任务，多前置依真实 all 契约列未满足项，不虚构任一触发。隔离正式命令夹具覆盖等待到下发，生产不可为截图手改任务/回执；不存在真实等待中的关系时，应明确原生等待态未验证，而不是造生产状态。合法实体 ID 往返、单次计划时区与取消前未发送文案随本版只读修正，既有真实发送结果仍保留。
