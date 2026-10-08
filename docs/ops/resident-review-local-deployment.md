# 常驻通知修复本地部署

## 群消息澄清与任务准入切换

本次同时修改 Assistant 与 Observer，无数据库 schema 迁移，按下文普通双包部署并保留既有请求。新协调候选必须提供澄清类别、具体缺项、阻塞动作和已核对来源；历史澄清不自动改判或重发。任务准入不足由 Host 生成 `needs_authorization`，授权仅绑定当前来源、话题版本和动作，不能代替执行阶段审批。开发任务可先承接，仓库和 UAT 在 Owner 工程准备前补齐；不默认环境或分支。

切换前运行本特性验收目录中的定向回归和隔离模型回放；后者不派发业务或发送群消息。切换后独立核对双包摘要、新进程、健康、收信箱授权状态及实际新消息的来源/话题/任务链。旧错误澄清仍保留历史证据；未经明确授权不重处理原消息、不撤回或补发通知、不替原业务任务开始开发。授权请求只允许配置的任务所有者通过原请求明确同意或拒绝，来源或话题变化后旧授权不可复用。

## 回复完整性与执行过载恢复

群内业务补充请求使用已验证的具体缺项，完整保留换行与链接，不再截取排查摘要前160字符。部署后对已发送的错误消息使用已有撤回/更正操作，发送结果未知时只对账原操作，不重复发送。编号清单的钉钉回读格式按精确渲染差异核验，正文、编号或引用变化仍拒绝。

工程准备前核验配置的sourceRepository实际存在；缺失应恢复配置指向的独立完整受管源仓库，核对origin、main与用户指定UAT分支、无浅克隆/alternates/链接及工作树干净后，沿原Task重评入口继续，不重建Task。模型服务过载必须以原生会话终止证据识别，使用持久退避及有限重试；不要把未拿到提交结果当业务资料缺失。
业务信息补充后的继续请求与人为暂停恢复分别处理：active任务只接纳原来源并唤醒Owner；paused仍走控制恢复。旧TASK_CONTROL_CONFLICT未知命令只有在来源、任务身份、Owner/需求/控制版本一致且原控制事务未执行时，才可原子对账并保留同一Task；取消或终态不得恢复。

维护只停止新派发，不主动取消已开始的Agent回合。当前节点仅有pure/read、无外部效果且需要部署排空时，可使用已安装DSH公开 `session.cancel({sessionId})` 中断精确原生回合（不是业务Task取消）；通过当前Web正式Cookie认证，不输出登录凭据。先零写核对维护身份、Task/node/session及效果账，调用后必须独立看到turn/end、Host节点drained和维护busy全零，才使用ContinueMaintenanceId及当前revision重新Check并接续。没有这些证据不得停机；后续沿原Task正式恢复，不新增Task或重放成功步骤。原生aborted/user独立分类为EXECUTION_TURN_INTERRUPTED，旧窄证据只更正诊断并交Owner一次续行，不推断工具错误必由取消引起、不进入provider自动重试。

## 普通本地部署不备份历史副本

数据库变更验收证据交接修复无 schema 迁移，沿本页普通部署。切换后先只读核对原成功 Run 的节点工件、插件批准与执行事件序号、工单原始 SQL、Task/TaskRun DONE 及生产列定义；再按当前 Owner/需求/控制版本调用原 Task 的 `reassess-readonly`。成功外部阶段仅在节点排空、效果成功、批准有效且当前来源未变时允许重评。旧定义不改写，不新建工单、不再次执行 DDL；独立回读业务验收、任务完成和群消息后才算恢复完成。

当前无 schema 或历史文件迁移的本地部署直接使用 `deploy-owner-repair.ps1`，默认不复制控制数据库、任务目录、工件、Domain 或 profile 历史副本，也不遍历历史树计算备份容量。没有新增备份开关。仅保存此次精确包/profile 摘要、维护封存许可、控制历史只读快照和 `deployment-control.json`；这些是部署控制证据，不是业务数据恢复副本。

本次 round14 沿现有参数：`-Package <D:/dsh_home/packages/唯一Assistant包>`、`-ExpectedPackageSha256 <包摘要>`、`-ExpectedProfileSha256 <当前profile摘要>`、`-DirectQueriesProposal <保持当前查询配置的既有提案>`、`-TaskDirectory <真实Agent任务根>`、`-EvidenceDirectory <当前worktree/docs/tmp/新目录>`；先加 `-Check`。通过后同参数去掉 `-Check` 执行，可用 `-HoldMaintenance` 保持维护待独立核验，再使用同参数 `-Readback` / `-Resume`。本轮不传任何迁移、Bootstrap、RepairStoppedLaunch 或 Observer 参数。

部署启动统一通过已配置的 `DSH Web Local`。原流程临时禁用且保存了恢复许可时，在启动前恢复原 Enabled 状态；`-Resume` 继续幂等核对自启并恢复原生派发。分别回读 `/runtime/maintenance` 与 `Get-ScheduledTask`，不能把任务 Running 当作业务已恢复。

仍要求原生维护排空/封存、精确旧PID退出、禁用并按原状态恢复计划任务自启、持续owner独占锁、停机checkpoint、源/包/安装文件比对、控制历史独立回读、新PID与健康核验后恢复派发。Launch 记录 `backupCreated=false`，绑定部署控制证据摘要；回读及恢复拒绝包/profile/证据身份漂移。

已有 Bootstrap 首次数据接管、MessageImpact、ExecutionEventsIndex 和 TaskMigrationPlan 专用迁移沿原恢复合同保留其必要完整备份，不修改历史离线恢复规则。普通无备份部署失败保留封存现场与精确包/控制证据，不能使用原历史数据回滚入口，也不得把原库当成可丢弃的临时数据。

文件消息回补修复无 schema 迁移：按本页受控流程安装 Assistant，保留消息正文和来源版本。部署后独立回读 `/health` 的每组 listener/backfill 及 `inboundProcessing`，核对原冲突文件消息仍为单个来源版本；只有 `health=ok` 才代表本次消息接收恢复，不能把双端口就绪或跳过回补当作通过。真实正文/发送者变化继续拒绝，不能手工提高版本。

## 任务卡片汇总切换核对

当前完整步骤版本不迁移业务记录或 schema。沿用本页构建、双包校验及维护封存部署步骤；普通切换前保存精确包/profile控制摘要和维护历史校验快照，不备份历史副本。部署后分别核对 `/state/tasks` 的一项一张卡片、详情按当前计划全部阶段展示、有效前段保留且被替换后段无重复、旧链接映射当前详情，以及正文的当前归属/版本拒绝。两个已确认三阶段完成任务应分别展示30个有效节点；数量必须与切换时当前计划和各Run的当前节点只读比对，不为验收重跑业务。页面不提供执行历史切换，底层运行和工件保留；卡片样式沿用现状。标题摘要应不超过32字符、完整目标可展开；三个已选完成任务的详情工作流组为3/2/3，63个步骤开始时间应逐项对应当前节点startedAt，卡片展开列表为中文且对应本次耗时。宽1440与窄390都不得因开始时间或长耗时横向溢出。

归档现在检查整个关联任务，存在活动执行、未排空租约或效果时必须拒绝；不要用真实未完成任务试写归档来验收。重执行、整项归档及旧请求拒绝先在隔离测试数据验证。只读副本和浏览器模拟接口测试不代表正式实例已切换，安装包、进程、健康和正式接口须分别回读。

切换封存快照在初始群和追加群上统一按路径、摘要、验证范围及文件身份缓存核验；每次入站仍检查文件身份，变动或失败立即拒绝，不能删掉seal来恢复旧入口。部署回读会话列表时分别记录正式HTTP响应和隔离持久化读取时间，不能用后者替代正式页面性能。

部署回读区分物理任务身份与看板卡片身份：快照中的旧物理ID如不在合并看板中，必须经详情读取映射到看板内的最新逻辑任务，同时校验 requestedTaskId、logicalTaskId、taskId/latestTaskId；原数据库任务、节点及运行摘要仍独立核对，任一缺失或错配均拒绝恢复。

`deploy-owner-repair.ps1` 按脚本所在仓库解析源码及 `docs/tmp` 证据目录，不绑定历史 worktree。必须从本次已核对的检出运行，包内文件仍须与该检出逐字节一致。

工程只读工具分页上限为read 16000字符、list/search 200条。超限返回可纠正参数结果；部署后须检查真实会话能够缩小分页继续读取，不能仅凭工具注册成功判断。已停止的旧会话保留失败记录，重新执行走正式任务入口。

工程发现流程 v6 将文件定位和读取合入 `inspect-and-propose`，通过受管仓库的只读工具按需列路径、搜正文、分段读文件，不再向模型灌入整仓目录清单。旧 v5 任务保留原定义运行；仅当 `apply-changes` 因 `EDIT_PREPARED_INVALID` 等待、节点均已排空、前置准备成功且没有文件修改或交付效果时，启动时事务性重编排同一运行的新代次，保留旧节点历史，并一次性补足新节点的有限领取次数。已产生编辑效果的任务不得重编排。切换后回读运行定义版本、当前节点顺序、旧节点历史、领取上限与实际执行进展；只见迁移回执或 Task 显示运行中不算完成。若迁移门禁拒绝，保留原运行和存储，先排查原因，不手工改 SQLite 或重复创建 Task。

工程目录的 `purpose` 和 `routingTerms` 向意图节点说明各仓库职责，且不改变旧运行冻结的执行配置摘要。唯一关键词命中其它仓库时，新任务接纳和仓库重发均拒绝。v7 对空 `changes` 给出 `ENGINEERING_NO_CHANGES_PROPOSED`；v8 支持精确局部替换，由 Host 校验原文件 SHA256、唯一原文并合成完整文件；v6/v7 历史定义保持原样。对无编辑及交付效果、节点排空且等待在空方案的旧工程运行，可由本机同源 Web 操作者调用 `POST /tasks/<taskId>/reissue-repository`，正文为 `{"repositoryId":"dataset","requestId":"唯一重发请求标识"}`。入口按 `workflow.webActorId` 和任务访问权限校验，事务保留原任务和节点历史，新增代次从准备节点执行；同仓库仅允许 v6/v7 空方案升级一次到 v8，重复 requestId 幂等。先核对目标仓库已准入、实际等待原因及效果账，再调用一次；调用后回读任务 ID、代次、版本、当前节点及仓库读取工具结果。业务代码只能由插件任务流修改，本部署流程不得替它编辑业务仓库。

## 消息与任务工作流入口

Resident 关闭会依次尝试 HTTP、同步服务、监听、工作流及 Runtime 的清理，保留并记录原始异常。宿主可能捕获插件卸载错误后继续报告卸载事件，因此该事件不能独立证明会话排空或控制库解锁；部署仍须执行下述维护、排空、owner 锁和进程回读。若旧版关闭短路导致占用残留，先保留维护并按实际原生句柄及控制账取证，不手工改写 drained。

### 问答 Agent 与调查流程切换

仅部署问答查询配置时，既有 `deploy-owner-repair.ps1` 使用 `-DirectQueriesProposal <绝对JSON>`，与 `-Bundle/-MergePolicy/-ChecksProposal` 互斥，禁止Bootstrap；不更新工程验收配置。可同时提供 `-ObserverPackage/-ExpectedObserverPackageSha256`，两包各自校验后由同一次原生 plugin add 安装，容量按两包计算，回读/Resume再次核对两包。先 `-Check`，保留原维护、封存、owner锁和恢复门禁；普通无迁移部署不复制历史副本，已有历史迁移专用路径保留其必要备份。配置器 `scripts/configure-agent-query-resources.mjs --check/--apply --profile <绝对YAML> --proposal <绝对JSON> --expected-sha256 <SHA>` 只接受 Agent 自身明确的资料/固定提交/status授权；数据库提案显式提供 `credentialsPath`（绝对文件路径）与 `databases: [{id, connectionId, tables: [{schema, table, columns}]}]`。使用现有 UAT 账号时，仅目标数据库资源显式追加 `environment: uat` 和 `identityPolicy: host-enforced-readonly`；其他环境不允许该模式。permissions 的 `databaseIds` 必须逐项对应全部登记数据库。表列仅接受明确标识符，拒绝通配及重复。可只登记数据库而将资料/status数组设为空。配置器不读取凭据、不连接数据库、不创建角色；check 零写，apply 保留原文并按 SHA 执行 CAS。默认严格检查只读角色；显式 UAT 模式由 Host 限定结构化查询并逐次核验只读事务。登记成功不代表数据库验收通过。凭据不得写入提案，配置器只接受路径。提案包含 `expectedProfileSha256`、固定 `target=dingtalk-dsh-assistant.config.workflow.directQueries` 及完整 `directQueries`；部署方保存含真实环境路径的提案及原始证据，不提交公开仓库。


历史切换曾把 `answer.text` 替换为 `answer.objective`，并将旧只读材料编排合并为带工具的调查阶段。当前普通调查由 Task Owner 直接使用 Host 查询工具，不再注册独立调查定义。切换不是运行库历史迁移：已完成记录和工件保留，活动旧定义必须在安装前排空；启动遇到 `WORKFLOW_CUTOVER_ACTIVE_REFERENCES` 时停止切换并核对具体活动引用，不自动重排或改写历史。

1. 在本次检出运行 `node docs/acceptance/agent-direct-execution/scripts/inventory-legacy-workflows.mjs --check --db <控制库路径> --instance <实例ID>`；不传 `--output` 只读输出，保存证据时使用全新 `--output <路径>`（拒绝覆盖）。正式维护排空后再次执行，保存两次清点。确认旧流程活动运行、当前阶段、未排空节点及未确认效果为零。旧 `answer.text` 未完成命令须在旧合同下收尾或明确停止，不能交给新 Agent 猜测其含义。
2. 按下文备份、打包、安装流程部署 Assistant 与 Observer。正式 profile 的 `workflow.directQueries` 可登记 `resources`、`databases`、`statusResources`、`credentialsPath` 与 `permissions`。permissions 包含 Agent 自身的 `resourceIds` / `databaseIds` / `statusIds`，与群成员无关。旧 grants 不再接受，部署必须提供保持原资源范围的新版 DirectQueriesProposal，经 Check 和 CAS 切换；不能只升级包而保留旧配置。凭据只放受保护的仓库外文件，配置和工件不得包含密码。
3. 仓库资源冻结完整提交；状态资源限定固定 GET URL 和返回字段；数据库资源限定表、列。默认使用专用只读账号；用户明确指定使用现有 UAT 账号时，配置 UAT 专属 Host 强制只读事务模式，并实测写入拒绝。账号凭据始终只由 Host 读取，不交给模型，也不登记生产连接。
4. 安装后独立回读包摘要、进程、健康、流程目录及旧历史。新目录不包含 `task-investigation`，Task Owner 直接查询；工程与外部交付仍可按原权限发起；旧成功任务可读且没有重放通知。
5. 在已授权的独立测试群分别验证材料问答、真实资料/代码/数据库读取、调查交付、补充、取消、重启和权限反例。核对真实工具工件、会话、Task 增量与钉钉独立回读；健康正常及原生本地会话通过不能代替渠道验收。

本地隔离原生查询脚本 `verify-native-query.mjs --check <profile> <DSH_HOME> <输出目录>` 先做零写预检，`--run` 使用实际配置的 Codex Connect、原生 AgentLoop 与查询工具；会话与工件写入指定的新目录，不接入业务控制库或钉钉，模型认证仍使用正式提供商服务。调用时原生启动环境的 DSH_HOME 必须与参数一致。该模式不覆盖消息分流、Task Owner 或数据库验收。

同一脚本 `--message` 使用隔离控制库与真实模型执行消息拆分、关联、意图和问答 Agent；它断言问答命令成功、证据来自实际工具且业务 Task 为零，通知渠道明确禁用。因此该模式仍不能代替正式钉钉送达验收。

历史 `verify-native-query.mjs --investigate` 用于独立调查阶段的隔离验证，当前不再提供该脚本或该入口。当前验证须覆盖原生 Task Owner 直接查询、真实查询工件、零阶段/零 Run 的最终验收，以及查询错误纠正和权限反例；不能以旧调查阶段输出代替原生查询证明。

S 保留完整当前消息和已提供背景，R 逐页累积候选及排除证据，I/IB 接收完整必要材料与限制。S/R/I/IB 不设固定字节或累计输入/输出 token 额度拒绝，实际请求字节和提供商 usage 仅用于计量；默认调用超时 180 秒，节点租约由同一调用窗口加提交余量确定，调用次数与有界协议纠正仍有效。节点失败保存真实结束原因、错误码及 usage；明确容量失败等待系统修复，不自动重复同一输入。模型提供方实际容量错误保持明确系统责任。旧容量失败只在当前来源、材料和无副作用条件满足时恢复，不能把部署健康视为处理成功。

新消息先持久接收，再按事项影响范围协调；可能相关的效果保持等待，已证明独立的话题可以继续，材料失败不占整群模型锁。渠道自身发件按群和消息 ID 排除，收发信箱仅在独立渠道回读后显示已发送。当前版本 schema v6，部署前按[事项影响离线迁移](execution-foundation-local.md#事项影响-v5--v6-离线迁移)备份、停机检查和转换，禁止旧 worker 写新库。


`workflow` 配置显式提供 `groupIds`、`dbPath`、`instanceId`、`artifactDirectory`、`ownerActorId`。控制库必须由独立初始化/迁移步骤建立；常规插件启动不建库、不自动封存旧群。

启动在恢复任何旧 Resident 之前回读每个指定群的控制账：必须 `message.group.state=active`、`engine=workflow` 且存在 `legacySealRef`；同时旧存储不得有未完成 Task、未归类消息、未完成协调请求或未结 Outbox。只有配置没有持久切换事实会拒绝启动。发送失败记录仍属于未结投递，不能删掉或标记送达来满足门禁。

验证 `/state/workflows` 的消息节点、命令和预算；`/state/tasks` 合并旧任务与 `engine=workflow-v2` 任务，进度直接来自 executionNodes。`/state/groups` 的收信箱、发信箱按群合并旧记录与新工作流的持久消息和通知，同一消息 ID 或通知 ID 只出现一次；新消息按实际发生时间排序，新通知仅在渠道独立回读后显示为已发送。已切换群不再恢复旧 Resident，也不能通过旧 Web 新建 Task 接口旁路创建；未配置群维持原入口。通知与任务运行分开：渠道 ACK 不能标记送达，必须拿到可信消息 ID 后独立回读正文和群。没有消息 ID 时保留未确认状态。

配置页部署后回读 `GET /state/workflows/catalog`：确认 `engine=workflow-v2`、目标群在 `groupIds`、消息阶段为接收／上下文／S／R／I／派发，任务流程的可发起状态、版本和节点来自当前注册定义。实际浏览器中确认已切换群只显示只读目录，不出现旧“任务流程提示词”编辑器；未切换群的旧配置仍可折叠访问。通用配置保存不得改写已切换群不用的 `taskPrompts`。

运行看板在真实浏览器中点击 `workflow-v2` 任务卡片，确认进入节点详情且排队任务也可查看；模型节点才显示所属会话记录入口。旧任务仍走原会话入口，任务卡片进度图标与折叠交互不变。

入口本地回归：`node --test test/workflow-entry.test.js test/http.test.js test/workflow-service.test.js`；原生 Runtime 防双入口测试：`node --test --test-name-pattern='已切换群' test/runtime.test.js`。测试不向真实渠道发送消息。

普通澄清通过 `POST /workflows/<runId>/requests/<requestId>/answer` 接收 `{eventId,answer}`，禁止传入 actorId。此接口沿用本机可信操作者边界，只接受 loopback 和许可的同源 Origin；不是远程登录鉴权。Host 必须显式配置 `workflow.webActorId` 映射本机操作者，缺失则禁写，不默认冒认 owner。请求仍检查 permittedActors 和原请求身份。钉钉答复必须引用已独立回读的澄清通知消息 ID，并匹配同群唯一请求；Web/IM 消费同一首终态，迟到冲突只读回原答复，不创建新任务。本接口不提供生产操作批准，生产 approval 意图在未实现相应审批流程时保持 unsupported。

历史上先被独立接收、后折叠为澄清答复的消息，由恢复通路核对原请求已解决、澄清通知已送达且答复引用该通知，再把答复来源补挂原话题并结清其归类屏障。回读该答复的 `routingStatus`、`intentStatus`、`message.topic.source` 和原业务 Task 数量；补挂不重新运行意图或任务。任一证明不唯一或缺失时保持原记录并报告恢复失败，不按文本相似度强行关联。

旧消息重处理通过本机 `POST /workflows/<runId>/reprocess` 逐条执行，要求 `workflow.webActorId` 已配置。先确认原运行没有任何业务命令；有命令时接口拒绝，不能绕过。已尝试发送的通知仅在同群全消息 S 澄清、通知状态为独立回读确认的 `delivered`、对应请求为 `resolved` 且无业务命令时允许恢复；仅 ACK、发送中、结果未知、未答请求或单元澄清均拒绝。事务保留旧运行及原通知，继承已接纳的全消息澄清答复供新 S 使用，封存未答请求，创建递增来源版本并重新取当前消息与任务上下文。回读原通知不变、新运行的已答请求和新增业务命令数量；不得重新发送原澄清。对多条旧消息按原时间逐条调用，每条回读新运行及收发信箱后再继续，不能把原消息重复投给渠道入口。

审核问题的状态问句、数量补充与引用清单须按原发生时间依次回读 S/R/I：问句执行同群旧任务只读查询，数量说明记录为话题事实，引用清单收束为一次范围查询，不新建三个任务。查询应区分已完成且有 UAT2 交付标记的任务与已取消且无部署回执的任务。结果通知优先引用来源消息；发送 ACK 后从实际 `result.openTaskId` 取得投递任务并按同群、引用消息 ID 和正文独立回读。钉钉可能添加 @ 前缀或改写正文空白，引用通知回读允许空白归一化，正文差异仍不得标记送达。

进展查询验收：读取对应 `/state/workflows` 消息命令的 `result.flow`，应为 `task-progress-query@1`，节点顺序是 scope／candidates／readback／reply；`/state/tasks` 中不得因此新增业务任务。分别覆盖单任务、同群集合、无匹配、旧任务已取消与 UAT2 标记，回复不得把候选匹配当作已确认的问题归属。

群职责验收：从 Agent 配置核对当前 `agentNames` 名称及别名，从 `/state/groups` 核对当前群“会话职责”。身份捷径及恢复均使用当前配置，未配置时不默认本机身份；姓名及别名不是执行权限，仍须满足群职责和操作者授权。日常查询及澄清通知的持久 `payload.text` 应使用职责明确指定的唯一署名（例如 `- 资料助理代回`），未指定不自动署名，歧义拒绝；渠道引用的来源消息 ID 应与原消息一致。改名或改群职责后只影响新通知，不重写已保存正文。第三方“任务已创建，开始处理。任务：… — …”仅作为进展同步入站，运行应以 `message_quiet` 收束；此前误发的澄清需按真实渠道回执逐项撤回并记录，不再补发。

进展消息话题验收：静默结案与话题绑定分开回读。引用消息必须在同群已送达通知与来源消息链上证明唯一目标话题；有唯一证据时，`/state/groups` 的 `topicRefs` 指向该话题、`routingStatus=routed`，话题详情能回看进展消息。无证据或多话题时保持 `topicRefs=[]`、`routingStatus=pending`，不发回复也不建任务。启动恢复仅一次有界补录旧静默进展消息，不重跑 S/R/I。旧纯排查任务完成后再次收到同一问题报告，若未明确要求修复，须生成一次授权澄清并引用原消息；原提问者或已配置的任务所有者可引用该通知答复，其他群成员的引用按普通新消息处理，不能答复该请求或阻断群消息补拉。肯定答复后新建工作流任务，旧任务保持只读。旧消息重处理先核对原命令和通知，避免重复外发。通知首次准备时冻结正文；群职责变化后恢复扫描须复用已保存正文，不按新规则重写历史通知或阻断后续待发通知。

归一化回归两消息验收：先按原时间处理问题报告，再处理引用该报告且明确要求当前配置的 Agent 修复的消息。R 补入旧任务历史后应在容量内完成关联，保留 `omittedCandidateCount`；首条仅沉淀话题，不把旧“单位不一致”修复误作本次归一化修复任务。第二条满足群职责的显式交办准入时才创建一个已登记仓库的工程任务，外部效果流程不因此开放给群成员。分别回读消息命令、话题及任务看板，不能凭模型接纳或发送回执宣称任务已经开始执行。

话题看板同时列出旧引擎话题和新工作流话题；收信箱的新消息从持久 `message_topic_bindings` 读取话题引用，不能填空数组。尚停在 R 节点取材料、没有确定话题绑定的消息继续显示待关联；不得凭相似标题硬挂旧话题。已确认的历史无命令消息可经 `docs/acceptance/message-reprocess/scripts/backfill-topics.mjs --check` 先校验，再在实例停止和备份后用 `--apply` 写入确定的话题事实；完成后独立回读话题列表和消息引用。

消息接纳在同一 SQLite 事务中保存话题版本、带源消息版本和原文的事实、单元归属及命令。纯话题事实也可成为后续关联候选；有效话题限制由 Host 加入任务输入，不依赖模型再次复述。S 使用代码计算的 UTF-16 片段边界和全文长度，I 参数为严格命名合同（创建/调研要求 objective，工程准备前由 Owner 补齐 repositoryId 与 UAT；I 不提交 workflowPlan）。Task 与 Owner 原子接纳后由 Owner 依据受信目录初始化计划。字段校验失败只重试原节点并提供错误位置；必需上下文超限明确进入 needs_attention，不能制造无法补齐的空材料等待。执行材料就绪前不接纳业务命令，材料恢复不重跑已成功 I。

业务命令领取前执行 Host 只读准入检查：主体、工作流、仓库、目标任务和执行版本。不满足条件时持久 `rejected` 并生成拒绝事实通知，依赖动作同时拒绝；没有外部调用的已知拒绝不归 `unknown`。开始执行之后的异常仍按未知效果对账。旧已完成任务以 `engine=legacy` 的只读候选提供状态/结果，不能交给新 Controller 恢复，也不能因询问历史结果创建新任务。

本 runbook 用于未发布修复包在现有 Windows DSH `web` profile 的安装与验证，不升级 DSH、模型、OAuth、代理或其它插件。沿用[源码开发安装说明](../manual/install-and-configure-dsh-web.md)的原生插件安装路径。组织权限由负责人处理，本轮不重新登录、不主动重试或补发真实群消息。

## 群消息延迟修复的验收补充

本次调度/决策修复沿用 domain v9，不新增迁移；v8 到 v9 必须使用[独立迁移规程](workflow-storage-migration.md)。部署仍需按下文停机、备份、安装精确包并回查源码摘要，不能热替换活动会话的工具契约。

- 安装前运行 `node --test test/group-decision-contract.test.js test/coordination-fairness-native.test.js test/topic-runtime.test.js`，确认严格分支、步骤公平性、路由后自动重验及旧版本反例通过。
- 安装后分别读取消息 routingStatus、Topic revision/processedRevision、coordinationRequests 和关联 Task；端口健康不能证明任务已发起。
- 原生会话的 `dingtalk/coordination-dispatched` 应体现同群请求交错；量子让出不能增加 coordinationRequests.attempt。检查工具结果已落盘且同群模型不并发。
- `routing-required` 的草稿仅在内存中等待，不标成已接受。重启恢复来源重新决策，不批量补建任务、清空旧记录或重放外部动作。
- 真实环境只读观察新输入的入站、归类、Task 创建时间；实际渠道时延和钉钉送达须独立验证。未知待路由输入仍阻止提交，不能靠放宽此保护获得性能数字。

## 决策上下文与积压补修

- 决策必须能从首包看到流程索引和合法 section；未知 section 应返回合法值提示，流程正文按固定请求版本读取。内联消息不重复分页。
- 公平轮转检查短事务三步连续完成、30秒后边界让出以及路由抢占；不得把预算当执行超时强杀工具。
- 性能投影共用 v9 Domain，后台只提交一个计量写，等待事件按会话合并，close 排空；不改变每条记录回执的持久化语义。单文件整库写成本仍存在，独立监测实际提交耗时。
- 活动投影恢复使用固定快照，在同一后台有序队列先补历史后接live；API与后续叶子不等待历史统计追平。关闭仍排空，失败保留水位和恢复错误。
- 保留运行中的 Task，等安全结束再部署。切换后逐项回查来源消息到 Topic、Decision、Task；新建与旧任务续办分别确认，不人工改状态。

## 安装前自检

话题通知恢复操作须先读取原 Task/Run/通知与真实群消息，逐条区分承接、结果、澄清和拒绝。受管操作要求本群负责人从钉钉原消息明确写出 `撤回通知 <通知ID>` 或 `补发通知 <通知ID>`，本机 HTTP 预检冻结正文及事实摘要，执行时再次核验；只有 DWS 发送/撤回适配器和独立回读同时可用才执行。HTTP 的 loopback 边界不是业务授权，调用方自报的成功证据不能完成对账。已领取操作结果不明时只核对，不重复调用发送或撤回。直接使用 DWS CLI 绕过 Runtime 的操作必须按已发生事实单独对账，不能把同源的有效承接与结果一并判错。

本次四条撤回、两条补发的对账使用 `docs/acceptance/topic-intent-task-composition/scripts/reconcile-notification-recovery.mjs`。先对确认过的控制库、工件目录及独立 DWS 查询快照运行 `--check`；停机并备份后在隔离副本运行 `--execute`，验证 Task/Run 和外部调用计数不变，再对原库执行并只读回查。脚本只写通知账和证据工件，不发送消息、不撤回、不重跑任务。

先确认当前运行实例的实际 `DSH_HOME`，不要按用户目录猜测。本机当前为 `D:/dsh_home`，profile 为 `D:/dsh_home/profiles/web`。在部署 PowerShell 中设置 `$env:DSH_HOME = 'D:/dsh_home'`，并以 `$profileDirectory = Join-Path $env:DSH_HOME 'profiles/web'` 定位安装和启动入口；其它机器必须核对其实际值。存储目录另外从 profile 的 storageDomain JSON `root` 读取，本机当前是 `storages/dingtalk-dsh-assistant-v9-pr116`，不能用包名拼默认目录。

1. 跑本轮回归和 `node scripts/build-web-client.mjs`，确认生成文件与源码一致。
2. 读取 `<实际DSH_HOME>/profiles/web/package.json`，保存 Assistant/Observer 两个依赖的原值用于回退；对 profile patch 和任务流程配置计算摘要，不记录凭据或消息正文。
   当前切换需对确认过的 `dingtalk_dsh_assistant` v9 JSON 文件做只读预检。先在脱敏副本验证，也可直接读取原文件；脚本不会打开 Domain 写入接口，不改原文件，不输出正文、记录 ID、凭据或源路径：

```powershell
node scripts/check-resident-storage.mjs --check --source '<已确认的v9存储文件或副本绝对路径>'
```

   必须退出码为 0 且 `ok: true`；输出各表数量、扩展字段数量、校验错误代码计数及 `strippedFields`。`strippedFields > 0` 表示当前 Schema 会丢字段，不能忽略后继续切换。运行中存储可能变化；停止已核实的实例、排空写入后，先把完整存储备份到仓库外受保护目录并记录 SHA256，再对稳定原文件重跑预检。备份包含业务消息和授权内容，禁止提交 Git。脚本只验证当前 Schema 可读且不剥离已有字段，不替代 Topic 引用和业务完成证据验收。
3. 确认 `<实际DSH_HOME>/profiles/web/node_modules/@deepseek-ai/dsh/lib/bin.js` 存在。本机全局 `dsh.ps1` 曾指向已删除目录；本 runbook 固定使用 profile 内的原生 CLI，不依赖全局 shim。查询 3080、18998 listener，确认同属当前 DSH Web 进程，记录 PID。检查进程与端口后才能停止该实例，不结束其他 Node/DWS 进程。
   同时读取 `node_modules/.modules.yaml` 的 `virtualStoreDir`，确认它指向当前 profile 下的 `node_modules/.pnpm`。若 DSH_HOME 或 profile 曾迁移、该路径仍指向旧目录，先停机并在当前 profile 执行 `pnpm install --force` 重建依赖树，再运行原生插件安装；不得整体链接或复制旧 profile 的 `node_modules`。重建后按 loader 的实际 import 核对必需 peer 是否已安装，缺失时安装项目声明的精确兼容版本并重新启动验证，不能仅因插件安装命令退出码为 0 就判定可运行。
4. 在 `docs/tmp/` 下创建本次唯一打包目录（包含本轮提交标识），按实际修改打包内部包。本次协调修复只修改 Assistant，Observer 保持原依赖；同时修改两个包的任务才执行两条命令：

```powershell
pnpm --dir packages/dingtalk-dsh-assistant pack --pack-destination ../../docs/tmp/<unique-directory>
pnpm --dir packages/dingtalk-dsh-observer pack --pack-destination ../../docs/tmp/<unique-directory>
```

独立回读两个 tgz 文件大小和 SHA256。不得覆盖此前同路径同名包后依赖缓存刷新。

## 安装与启动

1. 停止已核实的 DSH Web PID 及仅属于该进程的 DWS 监听子进程，避免遗留重复监听；将新 tgz 绝对路径传给 profile 内的原生 CLI：`node "$profileDirectory/node_modules/@deepseek-ai/dsh/lib/bin.js" plugin --profile web add <assistant.tgz> <observer.tgz>`。
2. 回读 profile 的两个依赖，逐一比较安装目录与工作区源码及 patch 文件的 SHA256，确认原有 profile patch 未变。`pnpm pack` 可能移除 `package.json` 末尾换行：manifest 按 JSON 内容或仅去除末尾空白后比较，其他差异仍必须调查，不能一律忽略哈希不一致。
3. 若启用了任务表格同步，重启后回读 `/state/task-sheet-sync`，确认配置中的 nodeId/sheetId 未漂移、启动同步成功，并用 `dws sheet +read` 完整回读托管范围。`/health`、CLI 退出码或设置页提示均不能替代表格内容核对。
4. 通过已配置的 `DSH Web Local` 计划任务调用持久 `start-web.ps1`，不从部署调用者环境另起 PowerShell。先确认其输出重定向目标 `D:/project/dingtalk-dsh-assistant/docs/tmp/dsh-web-local/` 已存在，否则 PowerShell 在启动脚本前退出（本机曾返回 LastTaskResult=1）。stdout/stderr 只存本地 `docs/tmp/`，日志可能含登录链接，不进入 Git。
5. 启动地址在 loader 完成后才输出，端口出现不代表地址已可读取；先确认日志包含地址再做认证访问，不把空日志当作启动失败。确认两个端口属于新进程，检查 `/health`、`/state/agent-config` 与 Web 认证访问。配置摘要应保持一致；health 的组织权限错误需单独说明，不能将其写成插件测试失败或真实投递通过。

## 验收与回退

Topic 决策输出预算版本在安装前须完成工具协议与长历史回归。安装后只读确认运行包中的 `topic-runtime.js` 与本次源码哈希一致，并观察新产生的路由回执仅含请求标识、决策首屏不超过 12 KiB；超长事项可由 `group_decision_context_get` 按固定请求连续读取，必要依据未读完时决策应被拒绝。不要为验证而重放现有群消息、Task 动作或历史 Outbox。若还有运行中的本机 Task，应保留当前服务，等 Task 安全结束后再按本 runbook 切换。

替换链修复需同步安装 Assistant 和 Observer 当前包（仅状态说明变化，不调整页面布局）。停机前后对实际 Outbox 使用 `reconcileReplacementGraph` 做纯函数预检，引用缺失、环或不可比较分叉不允许跳过。安装后核查旧意图 superseded、最新通知真实 deliveredMessageId、撤回失败独立状态及尝试次数不再无限增长；查询未命中不能视为从未发送。新增 superseded 枚举同样禁止旧二进制直接写新存储。不得手工删记录、置 sent 或批量重发来通过验收。

阶段决策修复部署还需回读：失败意图是否转为 `rejected`、新决策是否完成、Topic `processedRevision` 是否追平、原消息是否收口、叶子报告是否从 `input-wait` 经版本归档或审阅得到终态，以及同一 Task 是否产生后续执行事件。不能仅凭 Session 文件增长或端口就绪判定恢复。新阶段身份不会跳过计划审阅；历史坏意图不手工改 stageId。新版本增加 decision 的 `rejected` 终态，旧版本 Schema 不支持该值，不得换回旧包对已更新存储继续写入。

源码测试、安装包一致性、启动、认证访问、看板合成数据验证分别留证。真实 DWS 投递保持未验证，不改 pending 状态来使看板变绿。

叶子职责边界修复部署前，先只读查看 `/state/tasks` 中的活动与等待 Task，核对是否存在历史 `waitingKind=coordination`，以及仅等他人后续检查的其他等待报告。旧 `coordination` 结果仍可读取，但新版不再提交或补发该检查请求；不要直接改存储 JSON 或批量把等待改成完成。对确认属于误扩范围的任务，使用受管的版本化任务修订，保留已完成的阶段证据，再由叶子按新版本提交结果。安装后分别核验等待审阅、Task/Goal 状态、Outbox 投递与实际业务证据；已有 Task 完成不因后续检查未回复而回退。

当前协调修复使用 Domain 版本 **8**，通过可选字段和默认值读取旧记录：Task 的 `activityProjection`、`stagePlan`，Group 的 `coordinationRequests`，活动的 `seq`，以及 `executionEvents` 内报告接收、审阅、处理、通知状态。旧字段和历史检查点保持可读，不运行全库迁移。首次恢复活跃旧任务时，从其已批准计划补齐阶段索引，记录 `stage-plan-reconciled` 与旧阶段数组；不更改原检查点、审批、inputVersion 或结果。没有已批准计划不补造阶段。`--check` 只验证读取兼容性与字段保留，启动规范化由两次重启幂等测试单独覆盖。

活动投影故障核验：注入短暂写入失败后，确认同一 Session 原事件按序补齐、`/state/recovery-issues` 当前活动故障解除；持续写入失败时应保持 degraded，不能仅凭较新活动存在就判定恢复。任务完成时仍保留故障 Session 以供监督器补齐；部署前产生的旧活动缺口需单独核对，不把新版重试机制当成历史回填证明。

新版启动后，监督器逐个读取已完成 Task 的持久 Session，审计并补齐活动投影；历史已裁剪的 500 条明细之前的数据无法恢复，统计覆盖范围应保留 `retained-only` 标记。观察 `activity-projection` 恢复问题和投影水位，不以 health 短暂为 healthy 代替队列审计完成。Outbox 的发送尝试、回读尝试和投递轮数分别核对，`deliveryAttemptCount` 不能推断重复群发。多 Unit 消息的任务派发还需检查 `dispatchAssessment` 来源 Unit 与当前流程版本。

历史已完成 Task 的 Session 若被清理，`/state/activity-audit` 将列为 `session-not-found`、不再无限重试；`/health.activityAudit` 汇总 pending/audited/unavailableCount。不可回填属于历史证据缺口，不等于当前投影写盘失败；若 pending 长期不降或 `/state/recovery-issues` 保留活动故障，仍需检查存储和 Session 持久化。

**不能仅换回旧二进制并继续写原存储。** 旧 Schema 可能在更新 Task/Group 时剥离这些新字段，造成通知恢复、水位或审阅状态丢失。曾写入新状态后，应先停止写入，保留当前完整文件和安装前备份；优先前向修复。确需降级时，先在隔离副本证明目标版本不会丢新字段、不会重放外部动作，再允许恢复写入；未证明之前保持停机或只读查看，不启动旧版可写实例。

不得直接恢复安装前快照覆盖切换后新产生的审批、通知或外部动作记录。回退包本身仍走原生插件安装并独立核对依赖和文件摘要，但包回退不等于存储已安全回退。若新旧存储不能无损转换，保留现态完成前向修复。

## 信息等待与阶段进度修复验收

安装前只读核对运行任务与等待任务，运行中 Task 不得被重启中断。使用隔离 Store 验证旧记录保留、跨序已审阅阶段登记、等待通知送达前不提醒、30 分钟与 2 小时有限跟进、恢复后旧 pending 通知失效。安装后只读回读 /state/tasks 和 /state/groups 中当前等待及 Outbox，群通知必须凭 deliveredMessageId 与 DWS 原消息独立确认；旧等待已有 sent 记录时不重发原询问。当前 method-select Task 只按受管版本化补充恢复已取证阶段，循环次数仍缺真实会话证据时保持未验证。


历史已发送旧式询问不会在启动时批量补发或自动催促。仅对核对过的当前信息等待 Task，可调用 POST /tasks/<taskId>/information-wait-notice 一次性登记明确暂停的更正通知；先独立确认旧询问的 deliveredMessageId、任务仍 waiting 且结果未变化。接口返回 enqueued 只表示 Outbox 落盘，随后必须读回新消息 deliveredMessageId 和 DWS 原消息；重复调用只复用同一稳定键。当前案例为 task-7e10fc01558bb150f5224affeb5196e4，勿对其他历史任务批量调用。

UAT2 角色菜单组任务 `task-ecf5a0c74b07381abba1330a4ebb4551` 的计划检查点曾因 `topic_context_budget_exceeded` 循环拒绝。切换前先只读回读当前状态、备份并对稳定存储运行 `scripts/check-resident-storage.mjs --check`；切换后确认 `topic-runtime.js` 哈希为本次源码，再检查该任务是否产生新的计划审阅、已确认阶段或明确终态。仅修复分页预算不等于业务菜单配置完成；不得手工写入检查点或任务完成状态。停机前若还有其它运行中任务，要分别判断是否可安全中断。

本轮系统故障分类修复需验证：固定审阅预算错误落为 `failed`，Task 进入 `waitingKind=system`，原 `submissionId` 和已确认阶段保留；同错误的新提交不会反复排队。核查 `task-system:<taskId>:<runSequence>:<inputVersion>:<code>` Outbox 只有一条；只有确认当前修复包已经装入且任务仍为同一版本时，才通过原报告的 retry API 重试。retry 会占用一个运行名额；其它 Task 占满并发时应等待空位。故障通知已 sent 时回读 deliveredMessageId，pending 且任务已恢复时必须 superseded。旧二进制的 Task Schema 不认识 `waitingKind=system`，写入这种状态后不得直接降级到旧包继续运行。


## 请求会话与性能优化的切换核验

本节是后续受控部署的核验步骤；本轮仅交付源码、测试与补丁，尚未执行安装、重启或真实群业务重放。沿用本文既有备份、精确版本安装、独立读回与回滚步骤，不直接修改 node_modules、存储 JSON 或配置来制造通过状态。

1. 切换前保存当前正式包版本、安装文件摘要、活跃 Task 和 pending coordinationRequests 的数量及身份摘要。读取原失败报告的 inputVersion、runSequence、submissionId，确认是否仍为 system waiting。不得批量恢复历史任务或重新发消息。
2. 新版本启动后，检查每个请求使用独立的 route/decision/review 会话，身份与原持久请求相符；同请求重试复用会话，终态句柄释放、原生日志保留。跨群、跨请求、旧角色或过期版本提交应被拒绝。重启不能重复执行已持久接纳的业务写入。
3. 协调会话读取外部资料必须经消息/资源读取工具。确认工具只接受当前消息和引用链内的身份；附件缺失、分页未读完、不支持格式或 URL 不满足公网 HTTPS 限制时明确失败。不要为了恢复旧 pwsh 行为而给协调角色开放工程写工具。
4. 对原报告调用 retry 前，核对修复包已实际装入、当前版本和授权仍有效。Runtime 先在锁内只读准备原审阅上下文；预算、流程或待处理输入检查失败，Task 应继续 system waiting，不能唤醒叶子。成功后仅恢复原 submissionId；容量已满时等待，通知过期时应 superseded，已投递通知仍独立核验 deliveredMessageId。
5. 新叶子输入应携带任务工件中已存在的准确工作位置，或明确 unknown。核对一个有 goal/验收目录的已知任务和一个缺位置任务；验证存在性不得被当成授权或历史证据仍有效。
6. 使用既有已鉴权入口只读请求 `/state/performance`，先记录 `observedSince`、coverage 和缺失计数，再按日/请求/任务筛选；同时读 `/state/task-timings`。不要导出凭据、正文或完整资源内容。分开比较累计资源时间、区间并集、未缓存和缓存输入；保留观测窗口、样本数量和业务复杂度差异。
7. 用新的真实输入观察首次实质回复、处理时长、上下文和有效阶段推进；不得重放历史业务动作获取样本。此前81条消息的人工路由真值、首次实质回复标注及冷缓存成本对照尚未完成，达到性能目标需独立证据。

DSH `@deepseek-ai/dsh-tool-fs-search` 的固定前缀剪枝补丁在独立源码仓本地提交，见本轮 [搜索记录](../acceptance/performance-flow-optimization/search/report.md)。它不随本插件自动安装；未取得可追溯的正式责任包前不能声称生产 glob 已修复。8条无固定前缀和4条宽 worktrees 搜索仍未解决，不得用增大 timeout 或改写结果集掩盖。当前 Domain 仍为8，新增观测投影可选；降级前必须验证旧版本读取是否保留新增字段，不能让旧 Schema 静默丢失计量状态。

报告契约 v2 切换时须停止旧活动协调/叶子会话并由 Runtime 重新绑定工具契约；外部调用方同步读取 received、reviewStatus、applicationStatus、nextAction，不再读取顶层 accepted/status。未知审阅异常进入 system waiting，保留原 submissionId；修复后通过原报告的显式重试入口恢复，不能提交新业务报告绕过阻塞。此批不改变 Domain v8 格式，后续 v9 升级须使用独立迁移规程。

## 无副作用的阻断通知重新决策

仅用于旧决策已blocked、failureOperationId等于outboundId、actions/operations/progress为空、没有任何相关Outbox、任务幂等账或reservation且该revision未处理的场景。先只读核对，保留证据与具体原因；通过既有 `POST /config/groups/{groupId}/topics/{topicId}/decisions/{decisionId}/operations/{outboundId}/retry` 提交 `{"resolution":"reconsider","reason":"核验结果与重新判断原因"}`。该入口原子标旧草稿rejected并保留记录，重新判断原始输入；不得用于有动作、已投递或未知效果的决策。旧恢复入口使用blocked状态CAS，迟到的旧Outbox也拒绝。不得直接编辑存储JSON。

活动任务中断仅在用户明确批准后执行：核验目标DSH进程树、停机后备份完整当前存储和profile，再安装精确包；记录每个活动Task的inputVersion/runSequence/childSessionId并回读恢复。原Session确实缺失的历史重开任务应单列，不把新建空Session当作成功恢复。

同稿检查点恢复按结构内容比较，不因存储字段顺序变化拒绝。重试保留原submissionId、checkpointId、submittedAt和既有审阅请求身份；已有reject必须应用原拒绝，不能变成批准或再开启一次审阅。真正不同稿仍保留pending冲突。仅在精确修复包核验通过后调用原报告retry接口。

## 历史重开任务缺失原 Session 的恢复

仅对已重开、queued、带reopenContext且resume原childSessionId明确返回该ID不存在的Task，Runtime创建新独立Session并先持久化新的childSessionId和`task-reopen-session-recreated`事件，再继续原TASK_REOPEN与Topic输入派发。旧Session ID保留在runHistory；其它错误及running/waiting不换会话。切换前按既有流程备份稳定存储，核对三个目标Task的taskId、轮次、来源版本与原ID；切换后逐个读回新Session、原Task身份、运行事件及未重复业务动作。旧轮执行细节不可恢复，当前轮必须独立核验；不得把旧结果映射成新轮通过。

任务表格同步读取与看板一致的异步任务视图，包含 `workflow-v2` 节点进度、等待原因与结果；不能只同步旧 JSON Task。隔离验证通过不代表真实表格回读，安装后仍按既有配置独立核验托管范围。

任务详情纯界面更新只打包 Observer；回读安装的 web-client.js 与源码 SHA256 一致。页面首屏显示状态、编号步骤与最新产出，历史执行展开后请求；不触发任务重跑或钉钉发送。

步骤耗时涉及 Assistant 的事件时间投影与 Observer 展示，两个包一起安装。无 schema 变更；启动后从已提交 claim/commit 事件增量恢复当前租约时间，回读目标 executionNodes 的 startedAt/completedAt 与持久事件一致。等待耗时只到本次提交，未知结束时间不猜测，不请求 /state/task-timings。

步骤产出与通栏排版更新也需安装两个插件。新增只读 `/state/tasks/{taskId}/runs/{runId}/nodes/{nodeRunId}/output?ref={outputRef}&cursor=0`，limit 默认 1200、上限 8000；仅返回业务 text、nextCursor、totalLength 和轻量 overview。服务端核对配置群、Task/Run/节点及输出引用；旧引用变更后拒绝继续分页。进入详情才读取，长文逐页追加，失败就地重试；原始工件对象不传给页面。在线回读既有节点正文与摘要一致，不为验收重跑业务任务。

任务状态映射修复需打包 Assistant：对无 Owner 且计划已 succeeded 的记录，回读 `/state/tasks` 为 completed/succeeded，结果原文及信息局限保留。已有 Owner 的验收和 waiting_confirmation 仍保持原门禁。该修复只读展示，不修改持久任务、不重跑流程、不补发消息；部署前实例已停止时保留停机状态，安装包回读不等于在线验证。

任务详情使用紧凑编号时间线：标题与耗时同排、产出按标签展开、进度条表示已完成步骤比例。节点产出补充材料正文、文件清单、变更和已记录检查结果；此次需同时安装 Assistant 与 Observer，沿用只读分页接口及既有备份/回读流程，无 schema 变更。

新工程任务采用交付物契约 v9：确认项目与修改起点、创建独立 Git 工作目录、编写修改方案、检查修改方案、按方案修改文件、构建与检查修改结果。方案节点持久化可下载的 `修改方案.md` 文档工件和可应用补丁；应用前检查文档非空、长度和变更文件覆盖，这不等于证明方案技术正确。工作目录回执包含实际位置和来源仓库，当前使用独立 Git 仓库而非 git worktree。检查报告明确打包、构建、测试及跳过测试的范围，不把命令成功当成业务验收通过。历史节点保留原定义；未保存方案说明时仅提供由实际补丁整理的 `修改记录.md`，不补造理由或重跑任务。

节点产出统一核对当前分析/工程链：只读分页附带 overview，文件数量依据完整工件去重；默认显示读取、修改、索引或方案涉及数量，展开后才渲染正文与清单。提交/推送准备、执行回执、PR 草稿/创建/回读分别呈现，不相互冒充。未知结构标明“已保存节点产出，暂未提供可读展示”。


交付物契约 v9 同时安装 Assistant 与 Observer；无控制库 schema 迁移。已有登记定义继续按其版本恢复，新任务才使用 v9。安装前核对旧定义摘要保持不变；安装后逐页回读现存工件和可下载文档，检查旧目录回执与节点轮次一致。沿用停机、稳定存储备份和精确包核对流程；不能回放历史任务生成缺失方案。

方案编写及方案检查节点只显示实际方案工件路径，不展示正文、文件数量、展开或下载入口。当前文档与补丁持久化在 JSON 工件中，因此显示真实 JSON 路径，不虚构独立 Markdown 文件路径；其余节点保持原展示。

新工程流程 v10 将“构建检查”和“业务验收”拆成两个节点。构建成功只允许进入业务验收；缺少受信验收用例、没有实际值或实际与预期不符时，业务验收保持等待，阻止后续提交，不自动循环重试。验收通过展示验收项、预期、实际和结论。既有 v1–v9 记录保持原定义，不补造历史业务验收节点；v10 用于新任务与受管重发。部署仍需双包更新、备份及独立回读，无 schema 迁移。

## 本机重新执行已交付的工程任务

`POST /tasks/<原taskId>/rerun` 用于本机同源 Web 操作者将已结束任务接入最新流程。需配置 workflow.webActorId，且对原任务有权限。请求包含 requestId、expectedRunId（原任务当前最新运行）、objective、acceptanceCriteria、repositoryId、uatEnvironment，以及 stages 固定为 task-engineering / task-uat-pr-merge / task-uat-deployment、mergeTargetId、deployTargetId；constraints 可选。目标必须在受信白名单中。

Host 原子保存新的 taskId、真实 Web 来源和 rerunOfTaskId，保留旧运行及外部效果。相同操作者、原任务、requestId 的相同正文幂等，正文冲突拒绝；原任务仍活动或 expectedRunId 已变化则拒绝。开发分支从原任务可信记录复用，任务身份不等于新建开发分支。

新的任务只在 Web 留下进展与结果，不继承钉钉通知来源；补充、取消及重启恢复通过正式任务控制事件处理。入口接纳并不代表工程、业务验收或 UAT 提测已完成，需逐阶段回读。

### 工程输入依赖修复后的重执行

新工程 v14 显式声明方案、应用修改节点读取的 prepare-generation 依赖，旧 v13 冻结定义不改写。已因映射输入错误等待且尚无编辑/推送效果的运行，应通过任务 cancel 正式入口停止，回读控制状态 cancelled、所有运行终态和无未决效果后安装新包；再从原任务以新 requestId 发起完整重执行，保留原分支和 PR 身份。不得直接修改控制数据库或将原失败节点改成成功。

C 盘空间不足时，本轮保留计划任务定义，以原 start-web.ps1 和进程级 D 盘 TEMP/TMP 启动。安装回读必须分别报告 Web/control 与钉钉监听；degraded 不能记为整体健康通过。直接启动不等于计划任务配置已更新，空间恢复后仍需另行核对计划任务启动。

取消回读需同时检查 Task controlState=cancelled、执行节点 drained，以及任务投影 state=completed / outcome=cancelled 且无 waitingReason；旧 Owner blocked 记录保留审计但不再调度。controlState=cancelling 只代表请求已接纳，仍须等待排空。


## Owner 修复版本受控部署

新增空群可随本次部署提供 `-EnrollmentProposal <绝对 JSON 路径>`，内容只包含非空 `groupId`、`name`、`responsibility`。先确认真实群身份和成员，再执行零写 `-Check`。执行阶段进入正式维护后通过原生订阅接口登记空群，随后排空、封存、停机、备份和安装；释放部署 owner 锁后，由原生 `cutover-message-workflow.mjs --enroll-empty-group` 再次检查停机及锁，先检查后接管并 CAS 更新 profile。接入保留原封存快照和旧群历史。新实例回读并恢复派发之前不发送测试输入。

该路径临时禁用精确的 `DSH Web Local` 自启任务，原来已禁用且无恢复许可时，部署 Check 拒绝启动。原来启用的任务在启动前按保存的许可恢复启用。接入或启动失败保留停机/维护及证据，按 `enrollment-autostart.json` 和原生接入 journal 恢复，禁止删除 journal 后重来。`-HoldMaintenance` 会保留维护及临时禁用状态，后续使用原部署参数 `-Resume` 完成回读、恢复派发和自启。

先把同一正式版本的 Assistant 与 Observer 发行 tgz 存入 `D:/dsh_home/packages`，文件名包含版本和摘要前缀；分别核对下载来源及完整 SHA-256，发现同名异内容立即停止，不能覆盖。该目录是 profile `file:` 依赖的持久来源，不能用工作树 `docs/tmp/` 包路径安装；只在确认 profile、锁文件和部署证据均不再引用后清理旧包。部署工具的预检拒绝不在该目录直接子级的包及链接。

使用验收目录 `docs/acceptance/topic-context-completeness/scripts/deploy-owner-repair.ps1`，先 `-Check`，参数必须提供上述持久目录中的精确新包 `-Package`、双项目配置 `-Bundle`、合并策略 `-MergePolicy`、当前 profile 摘要 `-ExpectedProfileSha256`、包摘要 `-ExpectedPackageSha256`、新的 `docs/tmp/` 证据目录 `-EvidenceDirectory`。自检不创建证据目录，不改配置或启动实例。去掉 `-Check` 才部署；仅维护人员执行。

允许已排空的 waiting 任务留待新版本恢复，但 running 节点/Owner、未排空节点或 starting/executing/unknown 效果一律阻断。准备失败遗留 unknown 先按专用单次对账规程处理，不能靠部署放宽门禁。脚本要求原实例具备正式维护接口；已离线或尚无维护接口的旧实例拒绝使用此自动部署路径，须先完成独立停机与恢复方案，不能退回“读取排空后强停”的有竞争路径。

部署锁定精确双端口进程身份，离线取得原生 owner SQLite 独占锁后，普通无迁移部署仅保存控制证据、不复制历史副本；以下控制库、工件、Domain 与 profile 备份仅属于既有历史迁移专用路径：逐一对比完整源/备份清单，生成包含 WAL 最新状态的一致 SQLite 备份 verified-control.sqlite，并独立执行 integrity_check、foreign_key_check、逐表逻辑摘要与工件引用闭包校验。恢复使用 verified-control.sqlite；不得只复制旧主库而遗漏 WAL。输入包与配置摘要漂移拒绝继续。原生 CLI 安装后比较包内全部源码、工作区源码与安装内容，原生 CAS 工具更新配置。启动沿用原 `scripts/start-web.ps1`，仅该进程树使用 D 盘 TEMP，不修改计划任务。重新核对新 PID、双端口、在线 Task 身份、旧节点/终态 Run/legacy 任务摘要与配置；等待任务恢复后的新进展允许改变，旧历史必须保留。部署回读不代表业务验收或 UAT 提测通过。

## 前端审查草稿专项检查补入（单次配置修订）

`docs/acceptance/topic-context-completeness/scripts/configure-frontend-review-checks.mjs` 仅修改 `dataset-web` 的 `dataset-build.steps`：锁定 Node 22，在原 yarn install 后、build 前执行三个文件：`review-opinion-draft-persistence.test.cjs`、`audit-review-draft-storage.test.cjs`、`audit-reviewer-enhancements.test.cjs`（均在 `tests/`）。测试失败立即阻断该检查。原检查版本与其他字段、dataset 后端、`!!js` 和其他原文保持不变；新工程任务冻结更新后的完整 checks，旧终态不恢复。

先计算当前 profile SHA256，再执行零写检查：

```powershell
$profileSha=(Get-FileHash D:/dsh_home/profiles/web/cordis.patch.yml).Hash.ToLowerInvariant()
& D:/soft/node-v24.19.0/node.exe docs/acceptance/topic-context-completeness/scripts/configure-frontend-review-checks.mjs --check --expected-sha256 $profileSha
```

维护人员等待后端安全排空、停止实例后，使用同一预期摘要将 `--check` 改为 `--apply`。脚本需要原生 owner SQLite 独占锁，拒绝运行中/未排空节点与 Owner 或未知效果；共享 profile 更新锁、CAS、备份、原子替换和独立回读均须成功。摘要变化必须重新审查并 check，不能用旧结果直接写。重复相同配置幂等。禁止为了此配置更新停止仍在执行的后端。

2026-09-27：隔离测试 `test/configure-frontend-review-checks.test.js` 2/2 通过（原文稳定、幂等、零写、备份、锁冲突、并发摘要漂移）；真实 `--check` 通过，未 apply。

启动等待默认 `-WaitSeconds 300`，允许 1–600 秒。超出本次等待仍未就绪返回 `status=pending / ready=false / restartAttempted=false`，保存启动 PID、时间、包/profile 摘要与日志摘要，不宣称部署失败且不重启。使用原全部参数加 `-Readback` 接续；此模式只读取已有 `launch.json` 和控制快照、实时双端口及进程父子身份、HTTP、安装内容和历史，零写且不再安装/应用配置/启动。端口已监听但 HTTP 尚未完成也保持 pending；身份或证据不符则明确拒绝。旧工具没有 launch.json 的部署不能伪造此记录接续，使用原部署证据人工审查。

历史迁移专用部署前按实际备份范围统计空间，要求 D 盘至少容纳备份体积 + 包体积×10 + 1 GiB 余量；空间不足拒绝，不删文件。2026-09-27 本轮只读测量备份约 553 MB、D 剩余约 3.42 GB，未含新包时基线所需约 1.63 GB；新包准备后仍须执行完整 `-Check`。启动回读隔离测试 `pwsh -NoProfile -File test/deploy-owner-repair.test.ps1` 2/2 通过。

### 维护屏障与部署许可

文档读取能力升级后，旧 Task 的冻结正文链接由当前来源版本派生，无需补写附件或重跑交办。对已经接纳 wait 的 Owner，应先核对新版本可读材料、来源和 Owner/需求/控制版本，再使用既有 `POST /tasks/:taskId/reassess-readonly` 触发同一 Task 的系统重评；单纯重启不代表旧等待已恢复。重评理由只描述已部署能力和可核验来源，不冒充用户答复，不填入用户未指定的 UAT。验收须独立回读文档查询证据及真实 Owner 结果；只读工具测试、健康检查或重评 accepted 均不代表正文已读成功。

alidocs节点类型以同profile的`drive +inspect`为准。普通HTML文件不是adoc，不能据`doc +fetch`类型拒绝判断无权限；插件按明确类型走原生全文或文本文件下载。验收包含真实正文摘要、字节数和来源节点，不输出下载签名或凭据。

若监听ready但群回补报`GROUP_COORDINATOR_SESSION_ALREADY_LIVE`且Owner仍pending，先核对路由积压与`MESSAGE_INPUT_PENDING`，不得跳过输入门禁。新版协调器仅对公开idle维护锁内已核验身份、当前lease、工作区和无新增用户输入的观察会话，使用原生历史派生及现有账本CAS接回受管会话；原观察会话保留。外部活跃会话或不明输入继续拒绝，不按ID强行dispose。回读应包含新旧parentSession关系、积压路由处理、原Task继续及监听/回补健康。

正式部署先通过 `POST /runtime/maintenance` 开启持久维护模式，阻止节点、Owner、效果、消息执行及通知的新领取；入站仍可落队列。已开始的操作允许收口，未知外部效果必须先对账。排空后通过 `/runtime/maintenance/seal` 原子封存停机许可；此后旧进程不能退出维护，避免最后快照与停机之间重新派发。封存后遇到错误保持维护，不自动重复停机或重启。

新实例默认继承维护模式。完成安装内容、旧账、恢复问题数和认证 Web 回读后，才通过 `/runtime/maintenance/resume` 恢复派发；Host 自己校验进程身份已改变，调用者不能指定进程身份。`-Readback` 始终零写，返回 ready 也可能仍在维护；需要恢复时以相同输入执行 `-Resume`，该模式先完整回读再恢复。原始配置摘要及所有输入必须匹配 launch.json，不能换包或换配置接续。

若因部署回归已主动进入维护，接续部署须显式提供 `-ContinueMaintenanceId <现有ID> -ExpectedMaintenanceRevision <当前版本>`，并先运行同参数 `-Check`。仅接纳原进程、active、draining、drained 的精确许可；不能接管其他维护或已封存许可。接续失败保持维护，不恢复有缺陷的旧代码。需要在新实例中完成受控数据对账时加 `-HoldMaintenance`，新进程回读就绪后仍停止派发；对账完成后使用原部署输入与 `-Resume`。

### 已完成 Owner 的重复观察对账

仅用于阶段事件身份变更造成的同内容成功事件重复，不是通用状态修复。维护已排空时，`GET /runtime/maintenance/tasks/:taskId/completed-observations` 返回原完成决定、重复事件序号和 CAS 版本。逐任务审阅后 POST 同路径，参数为 requestId、completeTurnId、expectedOwnerRevision、expectedEventWatermark、maintenanceId、expectedMaintenanceRevision、reason；actor 由受信 Web 配置注入，禁止请求指定。仅本机受信 Origin 可调用。

原生命令在单事务内重新核对原完成决定、所有输入版本、阶段/执行终态、重复事件内容和维护许可。只将严格重复事件归入原完成决定并恢复 Owner 空闲；失败回合和审计保留。发生新输入、新决定、执行变化或许可漂移时拒绝。取消任务不适用；不得以此重新判定旧合同或业务验收。完成后独立回读任务仍 completed、Owner idle/complete 且水位相等，再正式恢复派发。

`GET /health` 的 HTTP 200 不是充分条件：必须 recoveryIssueCount=0，Web 需完成令牌交换并以签名 Cookie 回读页面。报告分别记录控制面和 inboundProcessing；已知钉钉降级不能写成整体健康。

### 本轮新定义与旧运行的部署边界

2026-09-27 的 R1–R10 修复改变本地验收 runner 实现身份及 UAT adapter 规则摘要。前端 waiting Run 与两条待提测 plan 仍绑定旧冻结定义，直接升级会拒绝恢复，不能改写其 digest 或把旧业务回执当新门禁已通过。正式切换前须通过任务控制入口取消旧待执行计划并排空，保留旧成功节点和回执；新配置、新 requestId 重新接纳开发及 UAT 链，复用原开发分支和原 PR，重新生成新门禁证据。

当前旧安装包没有维护接口；磁盘余量须每次预检实时核对，本轮后续回查 D 盘已恢复空间。本轮源码验证并不代表已经完成首次切换。不得因此降低磁盘门禁、删除已有文件、伪造维护许可或热改旧冻结配置。
## 首次升级旧版：Bootstrap 维护切换

仅当旧实例 `/runtime/maintenance` 明确返回 404 时使用部署脚本 `-Bootstrap`。网络失败、502 或已支持维护接口均不允许降级到此路径。先通过正式任务入口取消本轮旧任务并读回；仍有活动/未知操作时不升级。所有本机 HTTP 使用 `-NoProxy`。

部署参数在既有包、bundle、merge policy、双 SHA、证据目录之外，必须包含 `-ChecksProposal <ABS>`；其摘要同样参与预检、安装和 `-Readback`/`-Resume` 接续校验。先以同参数加 `-Bootstrap -Check` 运行零写检查，执行时去掉 `-Check`。

1. 核对旧 PID、创建时间和 3080/18998 归属。备份原 profile 到本次证据目录，以 SHA CAS 追加固定 `disabled:true` patch，保留其他配置及 `!!js` 原文；与 configure 工具共用 `.local-acceptance.lock`。
2. 由现有 DSH live profile reload 正式卸载 Resident。等待 18998 关闭且 3080 仍属于旧 PID，再持续取得 `control.sqlite.owner.sqlite` 的 SQLite EXCLUSIVE 锁。端口关闭本身不是排空证明。锁内核验控制账 busy=0，核对旧 PID 后停止旧 DSH；至备份、安装、配置及哈希验证完成一直持锁。
3. 保持 Resident profile 禁用。释放外部 guard 后，通过已安装新版 `openExecutionStore` 正式命令依次 enter、seal；该 CLI 自身取得 owner 锁、持有真实进程 nonce，并在 `finally` 关闭。此为首次升级的离线维护记录，不声称旧 Host 取得过 seal，也不 SQL 修改运行库。
4. 仅精确移除本工具追加的禁用块，保留新配置，启动新 Host。持久维护状态使恢复与领取保持禁止；新进程健康、历史、安装包和本次计划任务 `web.log` 中认证 Web 入口核验后，按既有 `/resume` 正式恢复。

任一步失败保持对应禁用或停机状态，不自动还原配置、不重复安装/启动。副本备份中的 profile 含禁用块，原始未修改 profile 另在证据目录 `profile-original.yml`；恢复时必须逐项核对哈希并先证明没有另一个 Host。离线 seal CLI 仅供此受控部署路径使用，不作为在线维护接口；其 `--check` 不模拟或签发许可，整体零写预检由部署 `-Bootstrap -Check` 提供。禁止对旧 DSH 发送 SIGTERM 后把退出当排空证明：其 disposer 有 5 秒强退上限。

### Bootstrap 完整卸载见证补充

独占工作流 owner 锁只能证明 `workflow.close()` 已完成，旧 Resident 随后仍会等待 `runtime.close()` 排空遗留叶子、通知和存储。因此首次切换先添加受信临时 witness 插件并回读 `bootstrap-ready.json`（本次 nonce、旧 PID、精确 entryId）；再追加 Resident 禁用 patch。见证器只接纳原生 Loader 在 `await fiber.dispose()` 完成后发出的 `loader/partial-dispose`，且必须匹配指定模块、disabled=true、fiber 已移除、disposing=0。`bootstrap-disposed.json` 成立后才取得 owner 锁并停止旧 Host。任意其他 entry、仍在 dispose、旧 nonce/PID 均不能作为许可。

现有 `pluginInventory/list` 不能替代此见证：Loader 在 await 前就先清空 `entry.fiber`，因此 `fiberPhase=null` 可能仍在排空。见证器仅记录生命周期证明，不读取业务数据或派发任务。安装与配置更新完成后，仅删除工具生成的两个精确末尾块（witness + disabled），不还原旧配置。就绪或完整退出回执超时，保持原状态等待人工核对，绝不强停。

### 已隔离自身回声遗留模型节点的部署排空恢复

本轮固定事故工具 `docs/acceptance/topic-context-completeness/scripts/recover-quarantined-echo.ps1` 只处理已证明为自身出站回声、运行已 superseded 且无业务效果的残留节点；不接收任意 run/命令。使用新的 `docs/tmp/` 证据目录和当前 profile SHA，先 `-Check` 再同参数执行。它进入正式维护、通过 bootstrap witness 证明 Resident 完整 dispose、取得独占锁备份、原生修复并回读，再恢复精确原 profile。最终输出 `ContinueMaintenanceId`、`ExpectedMaintenanceRevision` 给正常部署脚本。

如中断，保留现场并同参数加 `-Resume`。未取得完整 disposed 见证时禁止强停 Host；端口关闭不算完成退出。备份已有 manifest 仍会重新校验范围及每个文件/一致 SQLite 副本哈希。任何 profile、PID、维护水位或非目标忙项变化均停止，不能为继续部署清空其它工作。

### 原生查询会话目录

新任务的 Owner 和执行会话使用 Resident 已校验的 Agent 工作区下 `tasks/<logicalTaskId>/work/<内部taskId>/<owner或execution>/<sessionId>` 作为原生 `meta.cwd`；群协调常驻会话直接使用 Agent 工作区根目录，其他非任务新会话和已有任务仍使用 `session-workspaces/<职责>`。目录不采用模型/消息中的路径，消息意图判断不产生原生会话。群常驻会话的旧职责目录在 idle 且 lease/session 绑定 CAS 成功后以原生 seed/inheritedEventCount/parentSession 派生到 Agent 根，完整继承旧日志并保留旧文件；其他原生会话恢复保持原目录。群常驻会话创建及恢复均回读 danger-full-access/never 和完整群名标题，群名变更由下一次恢复扫描同步；DSH 原始日志存储根及后端保持不变。部署前回读 `agent-instructions.projectRootMarkers`，确认配置根实际具有受支持标记；普通目录可使用 `AGENTS.md` 或 `CLAUDE.md`，不能仅凭目录创建成功断言指引继承。此前已保存到 `_no-cwd` 的历史会话不迁移、不伪造 metadata；宿主 Session Controller 目录会排除这些已释放会话，因此历史看板会话入口不保证能打开，结果与依据仍可按需读取。验证新会话入口须在部署后创建新问答和任务，不能用旧会话证明新路径生效。

### 任务文件统一目录的部署与备份

本次无需 schema 迁移或新增 profile 配置。新任务文件根由已配置 Agent 工作区确定，为 `tasks/<logicalTaskId>/{work,tmp,outputs}`。新任务引用携带逻辑任务身份，旧引用保留旧位置；正式重执行的新内部任务复用原逻辑任务根。不要移动已有工程回执绑定的绝对路径，也不要改写引用。

正常部署脚本 `docs/acceptance/topic-context-completeness/scripts/deploy-owner-repair.ps1` 增加显式参数 `-TaskDirectory <Agent工作区绝对路径>/tasks`。升级后已出现新引用时，该参数为必填；沿既有部署流程，先以完整参数加 `-Check` 零写预检，核对目录、容量和引用闭包后再执行。尚未有新任务且目录不存在时可暂不传；不要为自检创建虚假根。`-Resume`、`-Readback` 及部署复核须沿用原任务根。

备份将任务文件复制到 `backup/tasks`，清单绑定源任务根并校验文件摘要；闭包检查直接查找限定引用，不扫描猜归属。依赖排除仅限 `<logicalTaskId>/work/engineering/<24-hex>/ws-<64-hex>/repository/**/node_modules` 和 Host 检查目录 `<logicalTaskId>/work/engineering/<24-hex>/checks/verify-<6-alphanumeric>/**/node_modules`，包括仓库根和嵌套依赖目录，显式保存于 `taskBackupExclusions`。容量统计、复制和源清单校验共用该规则，复制不进入依赖链接；备份目标意外出现额外文件仍拒绝。恢复后按源码锁文件重新安装依赖，不声称恢复了依赖缓存。

控制库、共享工件、Session 和任务根必须来自同一停稳检查点。缺根、坏摘要或排除范围外的链接均停止；不能仅备份原 `artifactDirectory` 后声称可恢复。恢复时保留原 Agent 工作区绝对路径，先验证完整备份再启动唯一写者。启用 workflow 后在线修改工作区会返回 `workflow_task_workspace_change_requires_offline_migration`，配置不写入；同根更新与模型修改仍可用。不要绕过此保护仅修改磁盘根配置，已有相对任务引用会失去原位置；换根须另行设计包含工程绝对路径绑定的停机迁移，本轮不迁移。

旧任务继续使用原检查器及验收 runner 的冻结身份。新任务使用任务目录版本的验收 runner，以保留服务直接子进程 PID 的核验，并单独给检查/验收子进程设置 TEMP/TMP/TMPDIR；不修改 Host 全局环境。新引用产生后，旧版本无法读取新布局，不能只降级包继续写新账；回退需按既有维护流程核对新增效果并恢复一致检查点。

切换后分别验证新普通文件任务、工程检查/验收、Web 重执行、重启后的文件下载和历史任务读取。核对原始 JSONL 仍在宿主 Session 根；本地定向测试不代表正式实例或真实钉钉送达已经验证。

### 用户指定终态任务的文件收纳

只有用户指定的已完成任务才能使用 `-TaskMigrationPlan <绝对JSON路径>`；计划逐项列出 source/destination 及可再生缓存排除，冻结已审阅 manifest 摘要。`scripts/migrate-task-file-links.mjs --check <plan>` 零写检查普通文件、同卷、全部祖先无链接、目标不存在、源 SHA 和文件身份；工具不自行判断业务终态，部署前从实际控制库及 API 确认身份、终态和所有代次。

部署完整参数先加 `-Check`。执行时维护排空、停止原实例、持 Owner 独占锁，在原完整备份外另存去重迁移源普通文件到备份同级目录，逐项 SHA 核验。计划、工具、包及配置摘要均冻结；随后落 fsync journal，rename 到任务根并在旧路径建立同文件硬链接，独立核对摘要、inode、device。中断按 journal 回退，冲突拒绝；Readback/Resume 只验证原 journal、独立迁移备份及原完整备份，不能重执行计划。

这是两个入口指向同文件的收纳；旧绝对路径、candidate 冻结身份及历史引用保持有效，不改任务状态或原始会话日志。原地写会同时改变两入口，原子替换会分叉，故仅处理终态旧执行，后续重执行用新布局。缺失的历史会话文件必须记录 missing，不能声称已保全。迁移不含共享凭据、公共源仓库、固定工具或日志；node_modules 排除仅按审核计划显式列出。恢复先独立核验迁移源备份清单及摘要，再在停机锁内按 journal 恢复原路径，确认完整控制账检查点与工程身份后启动。

### 已确认送达通知的单次对账恢复

当唯一未排空事项是已ACK的通知，且发送状态与独立消息回读均证明送达，可使用既有 `recover-quarantined-echo.ps1 -Scope notification -IncidentManifest <本工作树docs/tmp内绝对JSON路径>`。事故清单绑定通知、原消息、群、ACK操作、租约、通知摘要及维护初始版本；仅保留本地，禁止将真实主体和渠道标识提交公开仓库。

先加 `-Check -ExpectedProfileSha256 <实读SHA> -EvidenceDirectory <全新docs/tmp目录>`：实际只读DWS send-status及mget，核对操作→群/消息、正文、引用、唯一busy、容量和profile CAS，零写预检不创建恢复目录。确认通过后使用相同参数去掉 `-Check` 执行；中断后仅用同清单、同profile原摘要及原证据目录加 `-Resume`。清单或进程身份变化必须停止重新审查。

执行复用正式维护、完整Resident ready/disposed见证、配置fence、owner独占及完整备份核验。仅通过原生 `message.notification.readback` 接纳独立送达证据，不重发、不SQL修改状态、不用端口关闭替代完整退出。结果未知时回读原通知；已delivered且证据一致的接续不会再次执行命令。失败保留维护/fence，不能删除备份、手改恢复阶段或强停绕过。

恢复旧Resident后保持维护，独立确认drained及原许可身份，输出 `ContinueMaintenanceId` 与 `ExpectedMaintenanceRevision` 供标准部署脚本接续；恢复工具本身不解除维护或安装新包。部分备份未生成manifest时，Resume保留原目录并选择全新的backup-attempt-NNN重新完整备份；容量按仍需完整备份计算。存在唯一manifest时复用该目录并重新验证全部内容，损坏不会自动跳过；多份manifest明确拒绝。首次delivery-evidence/repair-readback保留原名，后续回读以唯一后缀追加，不能覆盖原生命令receipt。

## 调查阶段完成职责 v5

调查 v5 区分阶段完成与整体交付。部署前使用正式任务视图和控制账盘点 v4 活动及待执行引用；本次因报告保存要求而失败的测试任务保留产物，通过正式取消入口结束后再切换。不得改写旧定义摘要或将失败改为成功。新包独立输入重验调查与受信文档保存，核对实际路径、内容摘要及最终通知；旧终态历史保持可读。本次不迁移 schema。

## 任务产物群聊文件交付切换与验收

本节提供后续安装步骤与验收条件，不表示正式实例已经切换。继续沿用上文维护、排空、备份、精确包安装和独立启动回读流程；本轮实施不修改正式实例安装包或配置。

文件出口要求现有 `workflow.artifactDirectory` 为受信绝对目录、来源群在 `workflow.groupIds`，且 `dws.enabled` 与 `dws.writesAuthorized` 均已授权。发送 profile 使用实际绑定账号，逐件 DWS runner 的 cwd 固定为核验过的快照目录，传相对文件名；不要让模型传绝对路径或调用全局 `process.chdir()`。原有 `workflow.taskOutputDirectory` 的 Markdown 写入路径保持独立，指定名称的群聊产物放在 `artifactDirectory/task-files`。当前 Resident 文件 runner 沿用 30 秒默认命令超时；Host API 可在构造 runner 时设置 runTimeoutMs，尚未暴露为新的 profile 配置键。大文件须现场确认能在此时限完成；超时进入未知结果对账，不自动重发。

受管模块默认限制为 20 MiB/文件、50 MiB/批、20 文件；当前通用文本生成能力另外限制 UTF-8 64 KiB。默认值是 Host 的本地保护，实际租户限制需要现场验证；不要在 profile 中添加尚未暴露的容量配置键。快照及 descriptor.json 与现有工件目录一并备份，不手工编辑 descriptor、效果账或删除未知发送对应快照。当前没有自动清理器：保留所有活动、等待恢复和未知项；结束后的清理另走受管引用核对与零副作用预检，不按目录名猜所有权。

1. 安装前盘点活动和待执行的 `task-general-capability`，新产物能力使用工作流 v5，历史 v4 按原定义恢复，不修改旧摘要。确认 DWS 登录/profile 和指定测试群唯一对应；真实发件只在该测试群已经获授权时执行。
2. 在隔离控制库实跑相关回归：`node --test test/task-artifact-files.test.js test/task-artifact-write.test.js test/task-general-workflow.test.js test/task-group-file-delivery.test.js`。定向测试通过与正式安装、渠道送达分开记证据。
3. 安装后回读精确包、进程和健康，再读 `GET /state/workflows/catalog`，确认 `task-group-file-delivery` 是实际可用流程，并从 Task Owner 的 Host 能力目录确认 `write-task-file`；缺少必要出口时保留不可发起状态，不绕到 Agent 直接执行 DWS。
4. 新建明确要求向本群交付的测试 Task，覆盖中文含空格的 Markdown、SQL、图片及已生成文档。读取 `fileDelivery.sourceQuote` 与完整角色/名称清单，核对生产者、当前需求版本、受管原字节、逐件效果、真实 messageId/resourceRef 和下载 SHA-256。生成文件、上传 ACK 或 Pod/进程健康都不等于群交付通过。
5. 另验无发送要求、Web-only、跨群/profile、旧版本、缺必交项、路径/junction、部分成功、ACK 后恢复与内容不匹配。权限负例须零外发；未知项只对账，成功项不能重发。文字完成摘要失败也不得重发文件。

任务详情分别报告产物生成、逐件文件交付及完成摘要状态。必交文件缺失或待核验时不能完成。图片仅作为原文件附件；没有真实受信生成器时，Office/PDF/图片生成任务必须明确受阻。真实渠道验收记录保存在 `docs/acceptance/task-group-file-delivery/`，敏感群、账号及消息资源标识按现有证据脱敏规范保存。

### 已有文件的受信导入

登记已有文件使用现有 `workflow.generalFileRead: { root: '<受信绝对目录>', readablePaths: ['exports/报告.pdf', 'exports/图片.png'] }`。沿既有 profile 配置语法更新并走正式维护；这里只给合同，不修改正式配置。不要把整个工作区加入白名单，也不扫描目录自动打包。文件可来自已有受信产物，不需要另造外部生产者回执。

Owner 在 `task-general-capability` 阶段选择 `import-task-file`，`capabilityStep.input` 严格为 `{role,fileName,relativePath}`。来源必须同时在 Host `readablePaths` 和当前任务 `scope.readableFiles` 中，交付角色/文件名匹配 `scope.artifactFiles`；实际扩展名保持一致。准备环节只读取并冻结真实大小/SHA-256，模型不提供摘要或根路径；效果执行时再核对原字节才复制登记。路径、junction、身份变化和超容量均拒绝，不向群发送半包。

登记成功后，文件交付及恢复只读取受管快照；原源文件后续修改或删除不会改变已登记版本。准备后、登记前源文件变化则拒绝执行，不能偷偷改用新内容。独立验收覆盖准备零写、源变化拒绝、双重白名单、扩展名变换拒绝，以及登记后源删除仍可恢复；这证明导入与传输原字节，不证明 Office/PDF 内容质量或提供新文件生成器。

## 工作流任务归档入口修复

旧任务归档性能优化只减少单目录的重复预检及 Git 元数据命令次数。多目录仍先全部预检；删除前仍查询实时远端并复核 HEAD 和文档，不需要迁移登记数据。部署验收需分别核对单目录归档、跨任务占用拒绝及多目录预检；本地 bare 远端基准不能代替正式网络和 Web 响应时间。

登记 HEAD 是开发起点，旧版任务同目录同分支的后续提交仅在明确后代且当前实际 HEAD 已保存远端时允许清理；不是只读登记 HEAD 的字符串相等。归档保存实际核验 HEAD，并在迁出文档后再次检查提交与首次准备快照完全一致。登记后的历史改写、换分支及复制期间推进提交仍返回 identity_changed 并保留目录；不手改登记 HEAD 来绕过检查。

旧版任务的工作区清理还需核对实时 origin 分支公布的提交：登记 HEAD 等于其头或能通过本地 Git 对象证明是祖先时可归档，不要求原分支仍存在或头未推进。只读预检不 fetch；对象缺失无法证明时保持拒绝，先独立核对远端并获取精确对象后重试，不推送空调查分支来绕过检查。目录及 Git worktree 记录已移除时，登记文档可从记录 HEAD 的普通 Git blob 精确恢复，逐文件 SHA256 回读并保存归档元数据；未跟踪文件没有可信来源则拒绝。工作区同名报告可能是不同版本，不能作为替代源。先执行 checkOnly 预检，再从正式任务归档入口操作并回读 archivedAt、清理状态、文档及借用目录保留情况。

本轮只需更新 Assistant。`POST /tasks/<taskId>/archive` 使用现有空 JSON 对象，Web 仅受信本机身份可调用。新版在控制账事务检查完成/取消、运行和 Owner 收口、执行租约与效果排空，再追加 `task.archive` 事件和幂等回执；没有控制库 schema 迁移。部署后真实调用并回读 `archivedAt` 与任务产物，归档不会调用模型、群通知或删除工程目录。旧版 Runtime 仍按 `localWorktrees` 实际清理；不能绕过脏代码、未推送、未知文件或跨任务占用检查。测试任务应从明确测试群或来源验收标记识别，不把业务问题中的“测试账号”当作测试任务。

Web重执行群名修复：不迁移数据。安装后只读核对/state/tasks的sourceGroupId匹配原任务群聊且groupId仍为web来源；页面群标签应匹配groups中的名称，权限不可读取原任务时不展示其群来源。

卡片话题恢复不迁移数据。安装后只读检查/state/tasks的topicRefs及真实绑定，Web重执行引用原话题群；验证卡片话题入口、键盘打开和话题页关联任务。不要为验证新建或重跑真实任务。

闲聊话题规则修改后运行topic-runtime、topic-store、decision、group-decision-contract定向测试。双包受控安装后核对Assistant源码和新PID，隔离工具测试不代表真实模型语义或真实收信验证；不得为验证清理已有话题。

消息工作流的拆分节点允许以语义判断 `no_action` 结束无待办消息（闲聊、问候、无执行请求的收信测试等），必须完整覆盖原文并有成功节点记录，不创建话题、任务或澄清通知。明确的测试操作请求仍走正常事项流程。合法终态 `no_action` 不再占用未归类屏障；后续新消息可继续派发，真正尚未归类的消息仍阻断话题执行，无需改写历史状态。收信箱等待状态细分为“等待澄清”“等待补充材料”，提示显示当前待补充问题；真正失败仍显示“关联受阻”。

协调器已消费且判定零事项的消息，在同一提交事务结清本来源拥有的输入屏障。历史零事项遗留屏障由恢复扫描核对当前来源、协调器消费记录及无待执行事项后，以完整快照摘要 CAS 结算；未判定、来源过期、存在待处理请求或命令时保持屏障，不重放消息、不伪造用户答复。


### 封存后启动失败的离线修复

仅在原部署已取得 `stopping` 封存许可、原进程及 launcher 已退出、3080/18998 均无监听时，使用同一脚本的 `-RepairStoppedLaunch <原 launch.json 绝对路径>`。必须提供新的唯一修复 tgz、该包 SHA、原 profile SHA、新 `EvidenceDirectory`，以及原 `DirectQueriesProposal`（原部署使用时）；禁止同时改变工程配置、Observer、接入群或维护许可。

先运行以上参数加 `-Check`：零写核对原 launch/封存记录/control-before、当前维护 ID/revision/incarnation、历史控制记录以及源码与包字节。普通无备份部署使用原 `deployment-control.json`，核对 launch 绑定的控制证据 SHA、原包和 profile 身份、原输入摘要；仅允许未迁移且尚未恢复派发的 launch 检查点。该路径只替换 Assistant 包，不创建或读取历史备份，不回滚历史数据。原 Observer 包及安装结果继续独立回查，不通过 `-ObserverPackage` 再次安装。原 `enrollmentAutostartRestore` 及相应自启证据随新 launch 保留，在启动前按原许可恢复 Enabled，后续 `-Resume` 幂等核对。

原部署确有完整备份时仍走原备份专用路径：额外核对备份的清单/摘要/SQLite 全表与工件闭包、当前业务文件和工件全集。原生安装改变的 profile 依赖文件不与安装前备份比较，但原 profile 配置 SHA 必须不变。备份一致性副本仅允许原只读连接留下的空 WAL 与固定 32768 字节 SHM，其他新增文件拒绝。

Check 通过后去掉 `-Check` 执行。执行分支持有 EXCLUSIVE owner 锁，重新完成预检后调用原生 `plugin --profile web add`，持续持锁至安装包与历史再次核验完成；不执行 SQL 修复、不回滚数据库、不应用配置、不解除维护。旧证据保留，新证据目录继承 control-before/封存许可并生成新的 launch.json；无备份修复另写绑定新包的 deployment-control.json，保留原 launch/control/输入证据摘要链，Readback 再次核对。启动后无论 ready 与否均保持维护；后续以本次相同参数加 `-Readback` 回读，业务验证通过后才明确执行 `-Resume`。Check 不获取写锁，执行时锁竞争仍会明确拒绝。

维护期间消息节点领取被拒绝时保留正常暂停，不标记永久失败、不立即反复派发；解除维护后恢复原消息。旧版已误标失败的消息须从现有 Web 重处理入口恢复，先确认没有已生效的外发效果，不直接改控制库。

文件交付授权引用可逐字包含句末标点或跨句；Host按精确引用覆盖的完整源句核验否定与其他群限制，仍要求原文明确向群发送文件。误拒后未知命令保留证据，不自动回放；修复部署后用新的唯一专用验收请求验证，不手工改账或替换授权引用。

Owner安排带capabilityStep的通用阶段时，planChange本轮只能包含一个阶段，前序需成功；写入/导入产物核验后下一轮再追加群交付。提示明确该合同，存储约束保持。blocked的已有任务可由真实群补充约束事件恢复；尚未建立Run时Webcontext入口未覆盖，不声称此入口可用。

复合验收项按Owner显式绑定的当前任务已成功阶段联合语义核验；未绑定的其他阶段不进入。领域自己的结构、效果和执行输入约束仍独立验证。已冻结general v2合同保持源码身份，由验收协调层分别做原效果检查与必须通过的联合语义验收，缺校验器或结果不足不能完成。

IB共享判断仅合并完全相同的任务事实副本，各事项保留原权限范围内的引用；相同原生任务历史和话题来源全文仅通过精确引用复用，全部内容可完整还原；原文、约束及补读材料不裁剪，本次移除固定输入容量上限。已有无命令、无通知效果的容量失败消息可经现有 `/workflows/<runId>/reprocess` 原生重处理，执行前核对原消息版本和效果账；部署健康不代表该话题或Owner完成，需独立读回IB接纳及任务完成门禁。不得编辑SQLite或重发已确认交付的附件来制造验收通过。

I/IB动作条件必填字段与Host校验共用规则；例如report缺language仍拒绝。遇到该错误先核对正式包提示与校验的一致性，再走原生reprocess，不写默认参数或业务账。

### 完成验收的顺序证据

若任务要求“先生成读回、后续轮次再投递”，仅有两个成功产物不足以证明轮次和顺序。完成验收会从内部只读查询 `task.owner.planning` 取当前 Task 已应用的 initialize/append 及原生 appendStages 回执（后者仅标明原始类型，不推断模式），结合当前已验阶段的前驱引用、Run 时间及节点状态提供给领域语义校验；released 候选、待应用决定及其他 Task 记录不进入该证据。规划历史超过 200 条明确拒绝完成，不采用不完整历史。此查询不新增外部 API，也不迁移表或改写历史记录。

排障时分别检查结构门禁、真实顺序记录和模型判断。一次模型超时不能推断所有拒绝均由超时引起；不得通过删除验收条目或重发附件规避缺证据。现有文件、附件及原始会话日志保持原位置。

### 已封存但安装失败、尚无 launch.json

此时不要伪造启动记录。`-RepairStoppedLaunch` 可传原证据目录中的 `maintenance-sealed.json` 绝对路径：必须同时存在原 `backup.json`、`control-before.json` 与完整备份，原目录无 launch、配置应用、接入群自启变更或迁移记录。该入口仅重试 backup.json 绑定的同 SHA Assistant 包，`ExpectedProfileSha256` 必须等于当前配置和备份原配置；不传 DirectQueriesProposal，不再次备份、迁移或应用配置。先 `-Check`，再由同一参数执行；仍核对停止状态、维护许可、全部历史和备份，并在执行期间持有原 owner EXCLUSIVE 锁。

如果失败原因是 Observer 的本地 tgz 源丢失，可另外提供 `ObserverPackage` 与 `ExpectedObserverPackageSha256`，指向已有持久包目录中的恢复包。同版本恢复以当前已安装 Observer 为源码逐文件核验包（包含 package.json 的名称和版本），并核对原备份中存在该依赖；归档 tgz 的摘要可以不同，不能伪造旧完整性摘要。若首次安装在封存后、启动前失败，新版本 Observer 须与本次检出源码逐文件一致，且安装后再次核对；此时可与 Assistant 一同升级。已有 launch.json 的修复入口仍禁止 Observer 变更。

所有部署的零写预检及安装前都解析 profile 的 package.json 和原生 pnpm-lock.yaml（无 pnpm 锁时读 package-lock.json），检查本地 file: tgz 存在。正在安装的 Assistant 包可精确替代该包名对应的旧源：先核对目标包摘要及与本次源码一致，原生 `plugin add` 使用明确的 `@zzusp/dingtalk-dsh-assistant@file:<绝对包路径>` 覆盖旧依赖，安装后再逐文件核对实际内容；缺失的旧归档不冒充为已恢复。上述已核验 Observer 恢复仍可精确替代该包名对应的旧源；封存后首次安装尚未成功时，Observer 新版包可按本次源码核验后与 Assistant 一同安装。其他缺源仍拒绝。正式启动成功前保持 stopping 封存，后续仍按 Readback/Resume 门禁处理。

恢复 Observer 时脚本使用显式 `@zzusp/dingtalk-dsh-observer@file:<恢复包绝对路径>` 参数。pnpm 10.13.1 在旧 file: 源缺失时，传裸 tgz 会先解析旧源而失败；带包名的原生 add 能先确定被替换的依赖。隔离临时 profile 已实跑：裸包 ENOENT，命名参数成功且 package.json 由 pnpm 更新。不能通过手改 profile 或完整性摘要绕过此解析问题。

IB 话题来源身份使用无损引用：`sourceIndexes` 按原顺序指向 sharedTopic.sources 中唯一匹配的 sourceKey/sourceVersion；额外字段或歧义匹配不投影。`actorFromTopic` 仅代表该事实发送者与 sharedTopic.actorId 完全相等，不代表所有消息同一发送者，也不赋予权限。容量失败先核验当前真实完整输入和可逆性；不删除事实；当前版本已取消固定输入容量门槛，仍须记录提供方实际错误。若原失败消息无已生效命令/通知，使用原生重处理恢复该消息，避免为唤醒反复新增话题历史。

### schema 5 → 6 来源影响账迁移

本次部署沿用上述 `deploy-owner-repair.ps1`，完整维护部署参数附加 `-MigrateMessageImpact`。不能与 `-Bootstrap` 或 `-RepairStoppedLaunch` 混用。`-Check` 保持零写，仅声明迁移须完成离线前置条件，不宣称已在线验证数据库迁移。

实际执行先封存排空许可，保存并禁用 `DSH Web Local` 自启状态，停止原实例，获取原生 owner 独占锁，然后调用现有 checkpoint（验证停止、自启禁用、maintenance stopping/drained）、运行 immutable `--check`、完成原有全量备份及独立回读。checker 持锁进程只接受一次固定 `migrate-message-impact` 动作，直接调用迁移核心；不重新竞争锁、不暴露跳锁参数。迁移在事务中追加影响账及 schema 字段，独立连接核对全部原表 baseline；确认后才安装与启动。

`message-impact-migration.json` 保存 schema 版本、来源数量、原表摘要及迁移备份路径；摘要进入 `launch.json`。启动前、`-Readback` 和 `-Resume` 均核对证明摘要、schema 6 结构与每条来源的影响账完整性；在线仍执行既有旧终态历史核验。离线全量历史不变证明与在线当前态校验是不同门禁：启动后维护事件及当前工作流状态可以合法变化，不用迁移前全表摘要误判这些状态。接续命令必须保留 `-MigrateMessageImpact`。

迁移、安装或回读失败不自动恢复派发或自启，保留停机/维护状态与证据；禁止通过旧的简化离线修复入口跳过迁移证明。启动前只按本次保存的许可还原自启状态，派发仍须通过 `-Resume` 门禁。上述流程测试使用隔离库与模拟启动，不代表真实实例已部署。

通知滞留排障：prepared 没有 claim 不等于模型恢复阻塞。检查该 run 的 `notificationDiagnostics` 及既有 recovery 诊断，核对同一 Owner 报告的稳定 eventKey 是否已有通知；不得重发旧已送达报告或删除旧通知。当前扫描隔离单条事实失败，保留可回读诊断，其他待发通知和 unknown 回查仍继续；同一错误不按定时器重复写账。

任务通知统一静默：升级前 prepared 的承接、开始、阶段进展、内部受阻和待审提示在原生 claim 中 superseded；已 ACK/unknown 仍只回读。所有工作流共用结构化事实策略，不依赖正文关键词或 readonly-reassess 事件。完成、明确业务信息/授权确认及主动查询保留，插件私聊审批独立运行。按普通无备份部署安装 Assistant，无 schema 迁移；部署后核对无新增群进展，审批及任务最终结果单独验收。

### 消息首次领取与恢复时钟

每次模型节点领取独立保存 lease deadline，实际模型调用仍受单次超时限制，落账另保留 commitReserveMs。维护、并发槽及失败后的重试排队均不消耗下一次调用窗口；恢复不按包含排队时间的十分钟墙钟年龄拒绝。真实失败按 nodeId/leaseEpoch 去重计入最多两次恢复，重复扫描不扣次数，maxClaims 继续限制总调用。历史领取前超时由正常 recover 清除同原因事项阻挡，复用成功节点，不重处理来源；其他阻挡和未知效果不被解除。旧执行起点仍从最早模型 startedAt 推导供审计使用。

逐条重处理允许无业务命令、已独立确认送达的 `attention`、`routing_wait`、`system_wait` 纯状态通知，原送达记录保留在旧版本且不重发；发送中、仅 ACK、结果未知及业务回执仍阻止重处理。

每次节点领取必须由当前 Host 明确提供 `leaseWindowMs`（当前调用超时加提交余量），节点保存该窗口供审计；旧消息 policy 不参与当前调用时限计算。恢复预算耗尽保留原始 `recovery_exhausted`，继续使用受控重处理入口，不抹去历史失败。

## 文件材料与历史待执行指令核对

SQL 附件沿同一受管下载路径严格按 UTF-8 只读解析，保留原文与群/消息/附件身份，不执行 SQL；坏编码继续明确失败。验证需覆盖原脚本文本、临时文件清理与失败后重新读取，不能以模型猜测替代材料。

本次附件闭环无 schema 迁移，按上述完整维护部署安装 Assistant 及其锁定依赖 ExcelJS 4.4.0。先在隔离测试中核验真实 xlsx 解析、跨阶段材料继承、已有未领取命令的派发前核验，以及系统读取失败的等待和恢复。正式恢复前只读验证原附件消息身份和工作簿内容；分别记录工作表/行列覆盖，不把文件消息文本当正文，也不把表头计作业务数据。

恢复后逐项回读连续消息归属、Task 实际创建、执行材料、审批及验证阶段条件和渠道独立送达。不同消息恢复复用 FIFO 模型队列，不绕过相关输入屏障；已有成功节点与已投递通知不重跑。仅确认为无业务效果的失败消息可用受控 reprocess；已接纳的待执行命令沿原身份恢复，不手工清库重放。工作簿公式使用文件内缓存值且明确未重算，不执行生产 SQL 来验证消息修复。

受控 `/workflows/<runId>/reprocess` 不设来源版本次数上限；每次仍要求当前来源和无未确认业务效果。必须先只读核对命令/通知，再调用一次并独立回读新版本；重复或未知响应先查状态，不循环重发。历史模型调用计量保留，版本递增不等于授权重复任务。

### 本轮 PiAiAdapter 无备份续接

本轮按用户明确要求不再备份，也不复制旧 Adapter。已生成的目录保留，但中断的备份验证不作为完整备份证明。通用 `deploy-owner-repair.ps1` 未保留 Adapter 扩展；本次使用 `docs/tmp/message-processing-deploy/continue-without-backup.ps1` 接续已有封存停机状态，先核对维护许可、原实例退出和 owner 独占锁，再执行精确包安装。

Adapter 为普通依赖，原生 `dsh plugin --profile web add` 支持安装，不加入 profile layer。本次首次安装后的回读发现 hoisted 同版本旧包仍被 provider 解析：仅顶层安装成功不足以证明生效。因此在 profile 通过原生 `npm pkg set` 将 `pnpm.overrides.@deepseek-ai/dsh-llm-pi-ai` 精确绑定到持久 tgz，再执行命名 file 包的原生 plugin add；没有修改模型 settings，没有更换 provider 包。

精确包为 `D:/dsh_home/packages/deepseek-ai-dsh-llm-pi-ai-0.1.2-rc.1-native-stop-cbf6f3d68a6f.tgz`，SHA256 为 `cbf6f3d68a6ff708bb55ab301ae97fad735b43d60655fdde1bb2083b92719b79`。checker 保留只读 `adapter-package` 和 `adapter-current`：按 tgz 清单核对 17 个打包文件，不扫描未打包 src；从 `dsh-codex-connect` 实际入口解析 Adapter，再逐文件比对候选包，拒绝命中旧副本。LICENSE 对照工作区根文件，package.json 的工作区依赖转写以精确包摘要为身份依据。

本次安装后新 PID 29924 已通过回读并恢复至维护 revision 177；这些是本轮历史事实，不作为以后部署的当前状态依据。包、进程及健康通过只证明部署成立，消息重放仍须独立核对当前来源版本、命令接纳、Task 状态与通知 ACK/独立回读；不得将恢复派发等同于业务处理完成。无备份意味着本轮没有新增可声称完整的回退副本，失败时仍应保持封存并以已有证据定位，不自动恢复或重装。

### 已在维护中的双 ACK 对账（不备份）

用户明确要求不备份时，且唯一忙项是已知成功发送的两条 ACK，使用 `docs/acceptance/topic-context-completeness/scripts/recover-notification-readback.mjs --check <私有manifest>`。此入口只读控制库及 DWS，不创建证据目录或备份。manifest 必须包含 dbPath、instanceId、expectedPid、dwsProfile、maintenanceId、maintenanceRevision、actorId、notices（恰好两项、不重复）。每项包含 notificationId、runId、leaseEpoch、openTaskId、messageId、conversationId、sourceMessageId、expectedNoticeDigest。摘要由当前通知 JSON 的 SHA256 得到。

检查独立 send-status SUCCESS 与完整 mget：原 ACK 操作、消息与群身份、引用原消息、正文和通知摘要必须一致；任何其他 busy 或 unknown 拒绝。保存 stdout 为私有证据。此检查不授予强停权限，仍须按既有 Resident 完整 dispose/fence 流程退出旧进程，不可绕过未知效果。

旧 expectedPid 已退出后，再使用相同清单运行 `batch-repair <私有manifest>`。工具先再次只读核对与 DWS 回读，通过原生 store owner 独占锁取得唯一写者后重查；仅执行 `message.notification.readback`，不写 SQL 状态、不重发、不复制数据。部分完成可按相同清单接续，已 delivered 的项核对同一证据后不再写。完成独立回读两条 delivered 与全局 drained。

回读确认 drained 后，工具在同一原生 store 中执行 seal，将维护变为 stopping，输出递增 revision 和真实恢复进程 incarnation。工具退出后，标准部署以相同维护身份、新 revision、无监听及旧 PID 已退出接续；新进程原生 resume，不要求已封存的工具进程仍存活，不伪造原 Resident incarnation。批次工具测试通过不等于实际 DWS 已核验，正式 --check 和执行回读须分别留证。

### 指定问题批次清理后重放

使用 `scripts/cleanup-message-batch.mjs --check <manifest>` / `--execute <manifest>`；精确字段与顺序见 `docs/spec/message-conversation-coordinator.md` 的“用户授权问题批次精确清理”。检查零写；执行须 maintenance stopping/drained、旧 PID 已退出、原生 owner 独占。先按原生取消/删除语义处理指定 Task，保存已发送消息的独立撤回审计；不备份、不按群扩大删除。保留 DWS 原历史，使用新消息运行标识重放，不复用旧命令回执。清理事务为受影响群轮换唯一协调 sessionId，sessionBound=false、leaseEpoch 递增、轮次来源与事件引用清空；仅删除选定 Task 的水位，保留其他来源、Task 水位及其他群。旧原生会话文件仅留审计，新会话从当前持久状态重建，不再恢复旧承接记忆。执行后回读 coordinatorResets 和群绑定；新进程恢复后再次核验 sessionId 未回退，旧绑定迟到提交必须拒绝。

### 已清理来源的离线原生重放

`node scripts/replay-message-sources.mjs --check <manifest>` 零写检查；`--execute` 仅在原 PID 退出且 maintenance stopping/drained 时，通过原生 owner 独占取得 store 后再次检查。manifest 包含 dbPath、instanceId、expectedPid、maintenanceId、maintenanceRevision、batchId（8–80位字母数字连字符）、sourcesPath、sourcesSha256。sourcesPath 指向已独立保存的 12 条原始 source 数组；工具核 SHA、唯一 sourceKey、身份及 occurredAt，按真实发生时间排序。

重放仅执行 message.receive，保留原 sourceKey/actor/body/context/附件；sourceVersion=1，runId 与 receive commandId 由 batchId+sourceKey 稳定派生，必须使用全新批次，禁止碰撞历史 receipt。策略使用当前 defaultMessagePolicy，过时 compactPolicy 提示中的“意图节点”替换为“协调输入”。不会调用模型、生成 Task、执行命令或发送通知；关闭 store 后另开只读连接核 12 当前来源、原 Task 集合不变、命令/节点/通知均零，再交标准部署启动和解除维护。

执行中断不自动重新插入已有来源：相同清单检查报 SOURCE_NOT_CLEAN，须先只读核对已收到条目；不能更换批次掩盖半完成结果或重复创建来源。此工具不停止进程、不解除维护、不写 SQL、不备份。

群协调来源合同修复不迁移 schema：保留原来源与常驻 session，经原生维护排空切换后重新读取材料。回读协调提交时核验非空单元覆盖完整 sourceLength、补充/材料来源以 fact 关联同一目标，以及调查目标未被伪造为 requiredExecutionMaterials。群协调不再另设 180 秒墙钟或 32 步上限；仍由原生 cancel/close 排空与租约权限保护，Task 和外部命令既有保护不变。

常驻会话恢复时保留历史，但必须对照本轮来源 `processing` 和提交 `acceptance`：协调工具的 `received:true` 不证明 Task 创建或执行。来源历史摘要从当前控制账只读取得；预分配 taskId、superseded命令和旧成功回执不能替代 `taskExists`。验证重放需同一 session 同时保留旧回执，并确认新输入看见旧命令无Task及本轮真实创建事实。

生产查询准入：directQueries.databases 明确登记 environment: production、现有只读副本 connectionId 和授权表列，并追加对应 permissions.databaseIds。每次读前核验实时副本及只读事务，生产主库拒绝；不配置 host-enforced-readonly。凭据由 Host 读取，不进入模型。配置登记、实际连接和 Task 读取分别验收；配置变化后通过 reassess-readonly 在原 Task 重评，由 Owner 创建使用当前能力的后续阶段，不能直接重跑冻结旧能力的 Run。用户明确要求不备份时，先用配置器 planAgentQueryResources 零副作用生成并核对唯一变更，再在原生维护停机及 owner 锁下按原文摘要 CAS 写入；不调用会生成 .bak 的 apply。


资源配置变更前核对当前调查定义已冻结 capabilityIdentity 和 allowedTools。缺失时先在原配置下原生启动并重建原摘要；仅摘要完全一致才通过 workflow.freezeCapabilities CAS 补齐元数据，不修改原摘要、任务或阶段。独立回读后再启用新配置；旧阶段 scope 能力摘要与当前清单不一致时停止查询，Owner 按当前能力重评后续阶段。此过程不提供旧消息编排兼容，也不降低定义漂移保护。

部署后分别检查真实健康和群回补。图片事件的下载提示与历史展示可不同，只有精确卡片与唯一 mediaId 相同才视为同源；资源或正文实际变更仍要求可信编辑版本。只读查询输出容量超限可在既有授权内缩列或分页纠正，不作权限缺失或致命故障。若群内已有结束/取消指令，恢复工具不得重新打开业务任务。补充消息只更新原任务，不逐条回复；发送前指向旧执行的状态回执作废，实际控制进度不带“已收到”前缀。

群协调恢复按当前来源版本、有效任务事件、模型配置及协调实现摘要判定条件变化；内部失败、重试、领取事件不能反向触发同条件模型重启。明确网络/服务暂态遵循 Retry-After 或递增退避，不设恢复次数和总期限。协调实现或原生群会话实现变更的部署自动改变恢复条件；外围依赖修复则通过既有原生事件发布相关授权/能力恢复事实后唤醒，禁止仅循环扫描或直接篡改协调账模拟恢复。

PR交付在预检网络故障时由原Controller按持久退避继续原节点；仅Host适配器只读核验完整、身份匹配的attempt-start日志且反复确认没有send-intent/send-complete后，才能以新节点lease经原生effect.rearmUnsent恢复同effect。失败观测和恢复证明都保留工件引用，观测收据按发送lease隔离。权限失败、损坏或缺失日志、发送后未知效果只待修复或独立对账，不重发；安全撤销、输入变更、审批撤销和旧lease仍阻止发送。

### 生产只读结构调查配置

`directQueries.databases` 中已登记的生产只读副本资源可增加 `metadataSchemas: [public]`，用于结构调查；仅添加精确 schema 名称。`tables` 的数据读取范围保持不变。先用 `scripts/configure-agent-query-resources.mjs --check` 核验提案，再按本 runbook 完成维护备份、安装包核验与配置应用，不能直接编辑在线 profile 绕过部署。运行后核验查询实际连接只读副本及 `transactionReadOnly=true`，再检查未登记表 `select` 仍拒绝。当前待应用提案只修改生产 Editor 只读连接的 public 元数据授权。

结构能力升级验证依次读取 `columns`、`constraints`、`indexes`、`dependencies`、`table_stats`，逐项保存原生 verify 结果、只读事务及生产副本证明；不以元数据权限授予业务 SELECT。`table_stats.estimated_rows` 是目录估算，`dependencies` 仅直接系统目录依赖，仍需对应登记代码检索才能判断应用引用。所有查询的分页覆盖证明包含 queryDigest、offset、endOffset、nextOffset；新调查 v8 completed 从原生成功查询回执重建集合，逐项要求引用或明确排除，并核对证据的连续覆盖及同版本截断文件补读。范围排除须精确引用查询证据并给具体理由，权限和任务归属校验仍先执行；旧 v5/v6/v7 Run 沿冻结合同恢复，不回写旧成果。

备份完整性验证识别控制账中reason=explicit-user-terminal-history-cleanup的明确终止历史清理事件，并要求该Task已不在business_tasks/execution_runs中。仅这些任务工件的文件缺失被记录为purgedArtifactRefs；数据库、历史引用及审计事件仍完整备份。普通task.delete的retained包含artifact-files，不属于已清理文件；无清理证明、当前任务文件缺失、已有文件损坏或链接均继续拒绝。检查、备份验证及失败启动复核采用同一规则，不修改在线控制账。

历史回执的节点输入、历史消息候选快照也会保留已清理任务的引用。只在控制账的execution_receipts/message_items中，按上述Task清理记录排除对应对象的闭包根；节点回执仅含Run时，用原生plannedStageRunId及historyRemoved阶段启动回执确认归属。旧直派流程按已保留dispatch命令的原生executionDigest，同时核对Task的32位和Run的40位摘要，不用名称前缀猜测。完整控制账和已有文件仍逐字节备份，未知归属的缺失工件仍阻止部署。

已应用查询配置及Observer但启动失败的launch恢复，ExpectedProfileSha256使用launch记录的profileSha256（当前已应用摘要）；原sourceProfileSha256独立匹配原备份profile。原Observer不得更换，恢复预检核对原tgz摘要、源码及已安装内容。不再次应用配置提案，仍核对原提案摘要、封存许可、原备份、当前控制账及精确新Assistant包。

### 看板加载与常驻显示

群看板仅查询消息业务状态投影，模型节点完整输入输出留在按需详情中；历史消息仍完整按游标读取。自动与手动刷新共用同一进行中请求。群常驻会话空闲时保留原生挂接，模型步进拒绝、工具清空；运行前排空展示句柄再按原租约和工具恢复，运行结束保持标题/权限投影可读，关闭插件释放全部句柄。原生大继承会话离线时不返回投影，不能只检查持久文件即宣称页面生效；部署回读须实际session/list和打开会话核对。

### Task 等待条件与只读重评

阶段成功只证明该阶段已交付，不能作为整体 Task 完成依据。整体完成须有当前版本 Owner 已应用的 complete 与逐项验收。新 wait/block 决定必须记录 condition：kind（business-input、approval、capability、permission 或 execution）、missing、responsibleParty、resumeWhen 和 evidenceRefs。看板保留具体缺失、责任方及恢复条件；内部决策或程序错误保留 lastFailure 诊断，不向群发送中间受阻消息，也不冒充交办人缺资料。已有历史决定不改写。

修复读取能力后沿既有 `POST /tasks/<taskId>/reassess-readonly` 接口恢复原 Task。先独立读取当前 Owner 与计划，提交 recoveryKey、reason、expectedOwnerRevision、expectedLeaseEpoch、expectedRequirementRevision、expectedControlRevision；本机身份必须匹配 webActorId。重评检查源消息身份和版本、当前需求与控制版本、执行排空及外部效果，不接受未知效果、正在执行、已取消或已应用 complete 的 Task。只有成功调查的计划但整体目标仍待定义或审批时可以重评；不直接写 SQL、伪造批准或重跑冻结旧 Run。相同 recoveryKey 与请求精确幂等，参数变化拒绝。

重评审计保留 previousDecision（action、condition、applicationStatus、lastFailure）、当前源授权和材料读取依据。独立回读 system.recovery、新 Owner 水位及原成功阶段 outputRef，确认 Task/session 身份和旧证据保持；由新决定安排使用当前能力的调查。补充定义、审批或能力事实通过既有受管事件推进，不能只循环扫描。原生重评接纳不代表调查完成，也不授权生产 DDL。

只读重评也可恢复因来源校验程序错误而拒绝的 advance：要求原决定版本和租约匹配、当前真实来源重新核验通过、仅有已排空的成功调查、没有外部效果或计划应用回执。拒绝决定保留审计并标记 discarded，由同一 Task/Owner 重新决策；不能用于重发已经执行的变更。Bytebase 创建工单键与执行幂等键分别冻结，执行仍核验原工单、计划、SQL、目标及包摘要。历史冻结 v5 原生审批观察仍读取原持久观测；其中“审批流程未配置”与管理员配置要求仅解释旧定义，不作为当前任务流程。当前建单后走插件人工审批，SKIPPED 不要求管理员启用规则；旧纯审批 gate 经受控 handoff 在同 Task 接续插件审批。自动发布已有 TaskRun 时只读取既有执行，不重复提交。

Bytebase建单可生成未执行Rollout并置Issue DONE，独立TaskRun与生产只读回查仍为执行证据。readback-issue身份校验修复后的恢复先执行冻结的只读节点证明原工单身份，再由原Controller恢复原节点；维护、控制、输入、未知效果和旧租约继续阻断。不重建已受理工单。历史冻结 v5 的 SKIPPED 仅表示旧原生审批观察未配置，不能据此要求当前任务修改全局规则或重复建单。准确未执行旧工单经受控 handoff 保留 SQL 与工单身份，在同 Task 送插件人工审批；批准后执行，驳回按意见修订重新送审。

Bytebase 3.18 的空 TaskRun 列表会按 ProtoJSON 返回完整空对象{}；仅该合法空对象或明确数组可证明未执行，错误对象/null/带其他未知字段不视为空。冻结readback-issue只读节点实际核验成功后沿原Controller恢复；不按错误名称增加恢复例外，不重发建单。


任务最终验收组合当前任务各条目明确引用的受信事实，所有领域共享一次语义判断。调查节点只核对自身结果结构及原冻结需求；其局部缺证不要求用后续新阶段补齐，已有前序原生批准、执行和回查证明可以参与联合验收。领域原生结构与效果核验保留，未引用、跨任务和无来源证据不能补足验收。冻结执行定义不改写，Host按调查结果结构v2选择当前准入策略，覆盖已有v6至v9工作流，避免逐项枚举Owner合同版本而漏掉已部署定义。

完成校验拒绝沿既有TASK_OWNER_COMPLETION_UNVERIFIED返回具体校验位置、阶段/合同、当前版本或缺失清单；领域已有原始诊断保持。负责人据此纠正引用或执行策略，内部诊断不作为用户缺资料或群中间进度发送。

群常驻会话在创建及恢复后除保存Agent根目录为cwd，还须经原生workspaceRegistry登记对应工作区并attachSession。目录正确不代表页面工作区成员关系已建立；部署回读同时核对原生工作区sessionIds、群名及完全权限。已派生的旧常驻会话可原生归档隐藏，任务会话和历史证明保留。

## 调查并入任务执行会话切换

本次不迁移schema，沿本页完整维护排空、封存、精确安装、新进程回读和resume。切换前必须没有退役task-investigation活动Run或待执行阶段；检查拒绝时核对真正活动任务，不修改旧冻结定义来绕过。当前用户已授权清空本地业务数据，切换前任务、审批和话题应为空，已接收消息去重回执保留，防止回补重建旧任务。

Owner直接使用现有directQueries登记资源及Task工件目录；查询scope和证据由Host生成，不新增凭据、扩大生产授权或新建审批系统。部署后检查当前工作流目录没有task-investigation，查询能力仍与登记资源一致，新Task持续会话有这些工具；独立验证零阶段只读完成及可纠正查询错误、旧证据拒绝，再验证插件审批/未知效果边界。健康和包摘要不替代实际任务闭环；生产SQL测试必须另有本次真人批准，不能借部署验证执行SQL。

创建消息在 Task 接纳后返回；命令落账后扫描原生待办并使用四路空位，完成即补位，恢复计时器负责重启接续，不等待旧模型回合才接纳或派发后来任务。单 Task 原生租约及当前需求绑定保持；部署排空须同时等待派发扫描、运行会话与应用动作。


本次直查切换的新工程目录采用 v18，以 Host 核验的当前 Task 查询 taskContext 准备工程方案；v17 及已有工程定义保留冻结恢复。周期恢复只扫描持久待办并派发，不等待模型完成；独立回读新任务可在已有任务调查期间派发、同一任务动作串行应用及停机排空。插件审批、受控写入与未知外部效果对账边界不变，查询成功不能替代变更批准或业务最终验收。

自启任务是否禁用以 `Get-ScheduledTask.Settings.Enabled` 独立回读为准；任务仍在运行时 State 可以继续为 Running，不能据此误判禁用失败。停机前先保存原 Enabled 对应的恢复意图，再禁用。启动前恢复及 Resume 后分别读取 Enabled。

停机前被检查中断而旧进程仍存活时，可使用既有 ContinueMaintenanceId 和 ExpectedMaintenanceRevision 接续原封存维护；要求同一进程 incarnation、准确 revision、drained=true、stopPermitted=true 和 sealedIncarnation 一致。已封存状态不重复 seal；任何身份或版本漂移均拒绝。进程已停止时仍按原离线恢复规则，不冒用此接续路径。

任务开始通知及阶段授权修复切换：部署后独立核验一个仍未结束的新Task仅一条开始回执，正常恢复及补充无第二条；已终态/取消的旧任务不补发开场。旧需求授权投影缺字段时，只能沿repair-stage-authorizations核验原文来源及准确需求版本恢复，再由原Owner继续；不直接写控制库、不猜授予新工作流权限。生产变更依旧提交工单并走插件真人审批，开始通知不证明工单或生产执行完成。

候选恢复升级不迁移schema、不修改冻结v7定义。正式部署后核对原Task/Run及失败工件保持，恢复资格变化通过现有Owner观察事件唤醒；无需伪造事件或重复建Task。真实恢复须独立回读新generation及当前受信查询交接，推进至本次工单/插件待审；仅健康与开始通知不代表恢复成功。任何已有外部effect或工单不准候选重做。

## 桌面安全重启及耗时

正式逻辑在 `scripts/restart-web.ps1`，本机桌面入口仅委托 `D:/dsh_home/launchers/restart-web.ps1`，并显式传 `-ProjectRoot D:/project/dingtalk-dsh-assistant`。源码交付工作树不改变主检出已有文件；本地安装把已核对的正式脚本复制到持久launchers，以SHA256独立核验，不备份历史副本。已有桌面入口的Check参数保留。

先运行 `C:/Users/64554/Desktop/App/restart-dsh-web.ps1 -Check`。预检确认已有实例/维护许可与自启入口、原生排空；Check不改变进程、自启或维护。再不带Check执行。正在维护、已有实例身份不符、活动操作未排空、未取得封存许可时均拒绝，不能直接启动第二个实例。

初始检查和最终回读仍以真实进程命令行、创建时间、双端口Owner以及health/recoveryIssueCount/匿名401为准。等待中无监听只读.NET原生监听表，不反复全进程或MSFT端口表枚举；端口集合变化或HTTP就绪时进行完整独立核验。所有者查询使用一条过滤后的MSFT_NetTCPConnection CIM查询；不是省略端口归属。登录URL只在最终回读当前进程日志时解析，不在轮询中重复读日志。旧进程退出也先看监听表，之后一次完整回读确认停止。

TimingSeconds输出InitialCheckSeconds、DrainAndSealSeconds、StopSeconds、ServiceReadySeconds、VerifyAndResumeSeconds、TotalSeconds。ServiceReady包含计划任务启动及新实例全部健康门槛，不能当作Node单纯导入或端口监听耗时。每10秒输出等待时长和已监听端口，240秒超时不重启、不自动解除封存维护；仍按原证据接续。

一次性诊断只记录模块计数、CPU、子进程可执行名称和耗时、匿名HTTP类别/耗时及监听时间，不记录参数、输出、URL令牌或凭据。临时Node preload须在实际新进程前启用，并在finally独立核对还原计划任务Action；诊断进程仍带preload，最终正常重启移除。不要把临时采样留作正式配置。

正式启动使用Node24原生module.registerHooks同步load透传；只把模块读取改为同线程路径，nextLoad保留Node解析、源码、缓存和错误，不转换模块内容、清空缓存或改写node_modules。预加载通过显式--require指定，不写NODE_OPTIONS全局环境、不留临时计时hook。

交付时将scripts/start-web.ps1、restart-web.ps1、web-module-loader.cjs三文件统一复制到DSH_HOME/launchers并独立核对SHA256。DSH Web Local仅改Action到该目录start-web.ps1，传入真实主检出ProjectRoot，保留UserId/触发器/Settings/日志位置及DSH_HOME。桌面入口仍是restart-dsh-web.ps1 -Check/正常重启；正式包部署工具也指向同一持久启动脚本并显式传ProjectRoot，避免后续部署重新走旧慢入口。

本机完整对照：不带同步hook的ServiceReady171.18秒/总181.54秒；只启用同步load透传为17.65/29.91秒；正式三文件入口无诊断为17.64/29.43秒。小9库import对照均约1.6秒，不能用其代替完整profile boot。主结论范围是当前完整启动路径，未把操作系统/磁盘的底层延迟细分为已证实原因。运行明细见docs/acceptance/web-restart-startup-speed/round-1.md。

## 历史话题归属与展示修复

仅用于已核对的同事项历史误拆。脚本 `docs/acceptance/message-clarification-admission/scripts/reconcile-topic.mjs` 复用本机受管 HTTP 接口，不直接修改数据库；源话题的来源绑定并入目标话题并更新名称摘要，保留历史请求/通知，不重跑业务命令、不新建 Task、不发送消息。新建此脚本是因为既有重处理脚本会进入业务调度，不能承载零业务副作用的归属修复。

1. 先只读核对源/目标话题、消息来源版本、已有 Task/命令/请求。本次已确认的四条交办链是 #122“边做边修插件”作为源，#123 文档、#124 点名、#125“按文档开发”已有话题作为目标；具体 topicId 必须从当前 Runtime 回读，不能仅凭序号执行。
2. 按本 runbook 标准部署/维护流程进入维护并排空；脚本不会自动进入或退出维护。随部署处理时可使用部署 helper 的 `-HoldMaintenance` 保持维护，安装回读通过后再做下述检查。
3. 用 PowerShell 参数数组固定检查和执行的全部输入。`--check` 只 GET 维护状态并 POST 零写检查接口，返回 `expectedDigest` 与待变更快照。源/目标、名称摘要、原因或状态发生变化必须重新检查。

```powershell
$topicRepairScript = 'docs/acceptance/message-clarification-admission/scripts/reconcile-topic.mjs'
$topicRepairArgs = @(
  '--source-topic', '<当前源topicId>',
  '--target-topic', '<当前目标topicId>',
  '--title', '数据集过程导入导出开发',
  '--summary', '按已提供的导入导出规则文档开发，在执行过程中发现并修复插件问题；原始交办和阶段授权分别核验。',
  '--reason', '已核对四条消息属于同一交办链，修复历史归属与展示，不重跑业务'
)
node $topicRepairScript @topicRepairArgs --check
```

4. 核对快照后，以检查返回的摘要和本次唯一 requestId 执行；脚本再次只读检查当前维护身份及摘要，变化时拒绝写入。`--apply` 必须显式提供这两个字段，不能凭新检查结果自动替换用户指定摘要。

```powershell
node $topicRepairScript @topicRepairArgs --apply --expected-digest '<check返回的expectedDigest>' --request-id '<本次唯一修复编号>'
```

5. 脚本在写入回执后独立 GET 目标话题上下文；再从 `/state/groups` 和 `/state/topics` 核对四条消息归属、名称摘要以及原请求保留。原请求的解决需另走其正式恢复路径，不把元数据修复当成澄清已解除。
6. 标准部署 helper 的历史回读核对 Task、Run、Node，不替代上述话题回读。确认本次话题与原业务状态均符合预期后，使用同一部署输入执行 helper 的 `-Resume`；维护身份、版本、活动执行或摘要冲突都应保留阻塞并重新核对，不跳过校验。

脚本默认仅访问 `http://127.0.0.1:18998`，可用 `--endpoint` 指定其他本机回环 HTTP 端口用于隔离验证。检查/执行的权限、排空、来源版本和摘要最终均由 Host 校验。


历史 coordinator 错误澄清恢复：仅当原消息没有任何业务命令，当前 pending 澄清对应已送达通知已由原生撤回流程核验为 recalled 并保存 recallEvidenceRef 时，可使用本机 `POST /workflows/<runId>/reprocess`。其他未知、未撤回通知仍阻止恢复。重处理保留原来源、作者、正文和旧请求审计，递增 sourceVersion，并用当前群规则重建 compactPolicy；不伪造用户答复。先读回撤回证据和零命令，再逐条操作，最后读回新来源版本、旧请求 superseded、新任务数量及当前等待。此入口会启动正常协调与业务派发，操作授权须覆盖原业务承接。

### 部署启动环境一致性

普通部署与离线 repair 都只触发现有 `DSH Web Local`，固定核对单一 Action、PowerShell 7 路径、显式 `DSH_HOME=D:/dsh_home`、web profile、主检出工作目录，以及本机已配置 Principal `64554` / `Interactive` / `Limited`；不修改 Action、Principal 或其他持久设置。Check 只读核验；Enrollment 仅可恢复先前保存的 Enabled 许可，不启用原本禁用的任务。

`launch.json` 记录 `launchMethod=scheduled-task`、任务名、调度时间；`launcherPid=null` 不冒充已知进程。回读继续核对双端口单进程、新 Node 创建时间，并核对其真实父 PowerShell 的入口参数/创建时间及任务 LastRunTime。认证 Web 使用固定 `docs/tmp/dsh-web-local/web.log`，日志更新时间须晚于新 Node 创建时间，然后仍由原 Web checker 验证访问；日志陈旧或认证失败不能跳过。

现场已观察到从部署调用者直接启动与计划任务启动的 DWS 认证表现不同，本修复只固定服务启动环境；Windows 底层凭据隔离原因仍未确认。测试与只读预检不表示本轮已再次部署或重启。

计划任务启动失败后的离线精确包续修按原 launchMethod 校验自启状态：scheduled-task 记录必须仍为 enabled，旧启动记录必须保持原 disabled 状态；恢复许可仍须匹配原 enrollment-autostart.json 并经摘要冻结。有备份记录仅在已知 scheduled-task 启动时接受原恢复许可，原迁移修复范围不变。

阶段授权候选纠正补丁不迁移账，不重复 reprocess：部署恢复后由原协调会话重新处理 pending 来源。独立核对原 sourceVersion、唯一 Task 和授权 sourceQuote/objective；校验拒绝应停留在模型同轮反馈，不能转成新的用户澄清。

旧澄清阻塞已接纳创建命令时，不再次 reprocess 或直接写库。先核验真实后续答复及原创建命令，部署时 -HoldMaintenance 保持排空，调用 `/workflows/clarifications/recover` 的 dryRun:true（零写），审阅来源、作者、话题、Task/效果不存在证据，再使用原 expectedDigest 和唯一 recoveryKey 执行。原答复正文、身份和版本由 Host 从已存在来源读取；Web身份仅作为维护操作者审计。执行后独立核验旧request resolved、原create pending、来源版本及taskId保持，使用原部署参数 -Resume，最后读回唯一Task、Owner与#124不再等待补充。未知副作用、其他作者、版本漂移或真实授权请求均拒绝。

### 控制存储不可用时原生重载

维护接口返回 STORE_UNAVAILABLE 时，不能把它当404使用部署 -Bootstrap，也不能直接强停Host。先只读控制库 quick_check 和 maintenanceStatus，确认 busy=0，并核对现有PID/双端口；保留unknown命令原状。使用现有 bootstrap-workflow-maintenance.mjs 的 witness/disable/enable profile CAS 原语，每步先 --check：取得同PID/nonce的ready，禁用Resident后必须取得真实disposed见证、18998关闭且3080仍原PID，持有owner SQLite独占锁并以snapshot再证实排空。释放锁后只删除工具追加的精确末尾块，核对profile恢复原摘要。原生Loader在同Host重开Resident/Store；独立核对maintenance API、健康和收信后重新走普通部署Check。此路径不调用seal-offline、不改控制账、不迁移数据；无法取得见证/锁/零busy时停止，不能用端口关闭冒充排空。

纯会话事实误分话题的恢复也使用 `/workflows/<runId>/reprocess`：仅已 settled、全部 applied 的 conversation-scope 静默 fact，且无 Task 绑定、通知、执行/外部效果、同话题其他 Task 命令时允许。先只读核验原来源、作者、正文、来源版本和上述零副作用证据，部署 Resume 后逐条重处理，回读旧来源 superseded、新来源版本递增。维护期间可能已登记新来源、但派发返回 RUNTIME_MAINTENANCE_ACTIVE；若遇此错误先读回来源版本和命令，Resume 后只接续既有新来源，不按失败回执推断零写入。随后独立核验原 Task 要求是否更新、话题是否一致；不重放原 create，不将维护操作者当原消息作者。公共事实不产生 Task 输入事件，实际需求补充须通过合法 revise 接纳。

工程准备若仅返回 Git exit128，应按配置的 `sourceRepository` 独立只读复现首条命令并核对目录；缺失源仓库不能误报用户未给UAT或GitHub未授权。恢复时使用配置的远端在原sourceRepository路径建立独立完整Git仓库，禁止浅克隆、共享alternates、symlink或改用用户主检出；核对origin/main和选定UAT远端SHA。既有Task尚无执行阶段/外部效果时，沿上述reassess-readonly门禁重评，不新建Task，不伪造需求补充。源仓库恢复不是功能代码提交、部署或业务验收完成。

上述工程前置恢复也要求当前 Owner 的 blocked advance 仅包含有来源条件的 task-engineering 初始化候选、计划版本0，且全Task无任何计划阶段/接纳收据/执行Run/效果；原来源与Owner/租约/需求/控制版本均须匹配。只有这个未生效工程准备分支不要求当前需求已产生查询证据，其他只读重评规则不变。恢复废弃旧候选并产生system.recovery审计，再由同一Owner重新决策；不按128或任意错误码自动重领。

已发过时通知更正：先按原通知ID和完整正文唯一定位，核对当前业务事实；用notification operation的recall/explicit_user撤回，独立核验recallStatus及证据。再用同一notificationId准备restore/correction和简洁更正文，通过受信host-web身份执行并独立读取notification-replacement及DWS回读工件。保持同一profile/会话/原引用，未知投递仅reconcile，不重复send；不把旧正文直接补回，不伪造群内授权消息。

### 历史工程会话归属的一次维护修复

工程原生会话已被普通历史观察接管、原节点领取新租约但没有对应原生输入时，先区分实际活跃执行与闲置观察。新建工程会话直接使用原生 `origin=subagent`；历史 header 不手写修改，也不增加在线自动派生路径。

本次维护复用 bootstrap witness/profile CAS：进入正式 maintenance，让其他实际工作自然排空；witness 证明 Resident 完整 Loader dispose 后，单独禁用 `session-controller`。维护桥须再次核对两个精确模块 disabled、fiber 已释放及两个旧 Agent/Session 均不存在，取得原生控制库独占，并按当前配置恢复真实工程定义。仅调用内部 `controller.prepareManagedSession`，核对精确维护 id/revision、原 Task/Run/node/input/lease、完成历史与零节点效果，完整 seed 派生受管子会话后正式 CAS 换绑排空；不启动模型、不重做成功步骤、不取消业务任务。

临时 profile 修改逐步先 `--check`；执行期间保持 profile CAS，桥关闭 worker/自有原生句柄后独立读取控制账及新原生 header。按精确尾块反序移除桥、恢复 session-controller、bootstrap enable，确认 profile 回到原摘要。随后走普通部署 Check/安装/Readback/Resume，并以新 lease 的原生输入及实际工具调用证明续行，不能以 running 投影代替。临时维护脚本及含真实身份的 manifest 留在 docs/tmp；不向版本库提交私人任务内容，不创建历史备份副本。

任务目录含大型验证检出时，文件枚举逐项合并子树，避免数组展开为函数实参触发 Maximum call stack size exceeded；已有依赖排除规则和普通文件/链接核验保持不变，不靠扩大忽略范围绕过预检。

正在执行的仓库读取会创建并删除临时候选文件，不能把在线文件枚举的ENOENT当成持久材料损坏。任务可能自动续行时，先通过正式maintenance接口停止新派发，回读busy全零、drained=true后，再携带同一ContinueMaintenanceId与ExpectedMaintenanceRevision运行Check和部署。排空前不删临时目录或忽略校验错误；正在执行的回合自然结束，成功结果保留。

### 共享任务材料与恢复核验

本次复用原Task目录与artifact引用，无控制库schema迁移，不移动原生cwd、不复制私有正文入验收文件。部署后按Task共享索引核验旧版本文档可发现、按原引用读到完整正文以及outputs产物可按相对路径读取；新材料出现不得要求重跑成功节点。history材料只作参考，当前授权与验收仍用原合同。原Task的实际模型材料读取与新执行效果另行验收，单测和索引存在不等于业务完成。

精确原生TRANSPORT/首行fetch failed复用最多三次退避；部署后的旧waiting重分类、当前租约真实工具调用分别回读。当前能力wait的只读重评沿既有来源/CAS/零效果门禁，即使尚未成功query也可恢复；不得伪造查询成功或用户补充。对应已保存round38/39证据分别保留。

换绑会话的恢复核验先验证原生rebind链，只承认rebind之前、精确父session且旧lease的已消费输入；不删除父历史以通过检查。离线回放通过仍需回查在线重分类回执和新lease实际执行。

旧工程任务在已接纳输入后Stage/Run引用不一致，由既有输入或恢复事务核验正式逐代input.apply链并同步Stage。切换后独立回读task.stage.requirement.reconciled事件、原Run代际和实际新租约工具调用；不得手改Stage引用，也不删除当前计划一致性检查。

### 工程检查配置的同代维护修正

检查路径不存在属于检查配置前提，不能驱动业务代码整代重跑。仅在正式 maintenance 排空、封存并停止 Resident 后，以控制库独占方式调用内部 `engineering.updateCheckpoint({runId,requestId,kind:'checks',checks,maintenance:{maintenanceId,revision}},controller,artifacts)`。`checks` 必须是已审阅的完整注册配置（本次只把固定缺失文件参数改为 `node --test` 并提高检查版本）；用当前安装绝对路径的真实工程工厂恢复定义，不伪造摘要或函数。调用返回 receipt.result 中的原 runId/generation、旧新 digest 和 evidenceRef；不启动模型、不执行检查、不创建新 Task/Run/generation。恢复 Resident 后才调度 ready 的 verify-candidate。先前成功节点、工作区、候选和旧失败证据均保留。调用失败不能跳过门禁改库。

此入口只接纳 verify-candidate 的明确工程验证失败、全部排空、后继从未执行且无后继效果；来源、Task控制和版本需仍匹配。83c 的仓库读取失败应先由严格原生证据重分类，再由 Owner 调用现有 node.resume；不得用检查checkpoint冒充读取恢复。

当前 profile 的全局检查配置尚未修改。先对两个现存 dataset-web Task 在各自到达 verify-candidate 时维护修正；待所有使用旧配置的非终态 Run 结束，并确认不存在未绑定 Run 的工程注册记录后，再统一修改 profile 为检查 v2。restore 明确跳过已终态 Run 和非当前定义；当前活跃 Run 仍校验原 repositoryDigest，提前修改 profile 会导致配置漂移。未来 Task 使用新配置，历史成功 Run 不重建。

共享读取目录约定：work/tmp仅允许顶层共享文件，work/artifacts精确SHA引用沿原摘要校验读取；outputs可读取嵌套产物。engineering仓库及原生session内部目录仍通过原工具访问，不经共享材料入口绕过仓库范围限制。

候选校验错误（无效替换、类型、no-change证据或方案文档）由既有Owner恢复：先读取原提案与紧邻validate-proposal失败证据，再repairCurrentStage/node.resume纠正原提案。必须为已登记工程纯validator，原来源/版本/控制有效、全链排空、无提案及下游效果；重复同问题按原一次续行门禁拒绝。原validator lease递增不归零，原提案和失败证据保留在恢复事件；不是checks维护操作，不需要停机或人工装桥。

### 原Run的本地验收场景检查点

沿用内部`engineering.updateCheckpoint`的维护封存与CAS流程，`kind:'local-acceptance'`传入完整`localAcceptance`及`scope:{taskId,uatEnvironment,requestDigest}`，摘要为`executionDigest({request:saved.input.request,acceptanceCriteria:saved.input.acceptanceCriteria})`。不得改仓库、checks或业务授权；`prepare-local-acceptance`及以后必须零领取、无输出和效果。原define/plan产物保留审计，真实重算这两个节点，保留成功workspace/inspect/verify；等待中的verify不会因场景修订冒充成功。恢复维护后按原Controller调度，不另建Task、Run或generation。新planner可纠正失败沿既有Owner一次续行规则处理；成功中段必须与checkpoint审计逐项相符，任何漂移仍拒绝。

生产活动合并UI组件检查脚本的离线提案在round53记载；其`backendVerified:false`是覆盖边界，不是可绕过的错误。配置仍复用原`prepare-web/serve-web`与固定SHA的dataset companion，必须先得到包含结果导出接口且业务验收通过的后端jar，才对原Task做local-acceptance checkpoint。不能把review伴随后端、候选导出或固定API fixture当作真实结果Excel验证。

若Owner已读取诊断仍报TASK_OWNER_RECOVERY_DIAGNOSTICS_UNREAD，纯validator纠正路径应核Host currentExecution的validationNodeRunId/validationLeaseEpoch/validationInputDigest与原失败工件，不应拿前置Agent身份匹配validator失败。round54含真实SG20副本和Owner完整集成证据；正常原Owner恢复入口不变，无需手动改业务状态或重建Run。

历史materials/source=previous误用恢复：只读核验原生错误调用为同Task精确SHA引用、sole ENGINEERING_READ_SCOPE_INVALID、blocked且未提交/无其他错误；正式重分类为QUERY_ARGUMENT_INVALID后沿原node.resume续同会话。不能将任意scope错误重分类，亦不重新创建Task/Run。

见证器在通过PID/nonce及绝对路径校验后创建证据目录，避免全新部署目录导致ready写入失败。重试仅允许替换工具追加的唯一末尾witness块，且模块、PID、证据目录保持一致；只更新nonce。目录、PID或块内容漂移时拒绝，不通过重复追加插件绕过。每次先执行 --check，再执行相同参数，独立回读本次nonce的ready/disposed。

必要后端依赖部署需要控制库存储版本8→9：沿 deploy-owner-repair.ps1 增加 -MigrateRequiredDependency，先 -Check 零写。仅完整正式维护部署，不能与Bootstrap、离线RepairStoppedLaunch、其他迁移合用。排空并原生seal后停止旧PID，持续owner独占锁中调用 migrate-execution-dependency-index.mjs；事务只更新索引和schema版本，全部业务表摘要保持一致。该迁移需要历史数据备份；独立offline baseline回读通过后才安装启动，launch.json保存迁移证明摘要，Readback/Resume再次核对工具/备份/收据及版本9。若迁移失败保持停机，不把旧包直接运行在版本9上；回退须按迁移前备份恢复整套数据。

后端单测报告核验如实记录skipped/实际执行数，不把已明确禁用的集成用例当普通单测失败。失败或错误、伪造计数、无报告、零用例、全部跳过仍拒绝。业务验收独立覆盖未执行的业务范围，不宣称skip项已通过。检查器完整stdout/stderr写入本Task共享dataset-check-host-unit-<uuid>.json，控制台只输出步骤退出码与首个错误，材料工具分页读取完整正文；旧截断日志不能倒推为完整日志。新工具以新摘要目录冻结并提升check版本，经正式checkpoint生效。
