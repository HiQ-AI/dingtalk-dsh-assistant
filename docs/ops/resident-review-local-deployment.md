# 常驻通知修复本地部署

工程发现流程 v6 将文件定位和读取合入 `inspect-and-propose`，通过受管仓库的只读工具按需列路径、搜正文、分段读文件，不再向模型灌入整仓目录清单。旧 v5 任务保留原定义运行；仅当 `apply-changes` 因 `EDIT_PREPARED_INVALID` 等待、节点均已排空、前置准备成功且没有文件修改或交付效果时，启动时事务性重编排同一运行的新代次，保留旧节点历史，并一次性补足新节点的有限领取次数。已产生编辑效果的任务不得重编排。切换后回读运行定义版本、当前节点顺序、旧节点历史、领取上限与实际执行进展；只见迁移回执或 Task 显示运行中不算完成。若迁移门禁拒绝，保留原运行和存储，先排查原因，不手工改 SQLite 或重复创建 Task。

工程目录的 `purpose` 和 `routingTerms` 向意图节点说明各仓库职责，且不改变旧运行冻结的执行配置摘要。唯一关键词命中其它仓库时，新任务接纳和仓库重发均拒绝。v7 对空 `changes` 给出 `ENGINEERING_NO_CHANGES_PROPOSED`；v8 支持精确局部替换，由 Host 校验原文件 SHA256、唯一原文并合成完整文件；v6/v7 历史定义保持原样。对无编辑及交付效果、节点排空且等待在空方案的旧工程运行，可由本机同源 Web 操作者调用 `POST /tasks/<taskId>/reissue-repository`，正文为 `{"repositoryId":"dataset","requestId":"唯一重发请求标识"}`。入口按 `workflow.webActorId` 和任务访问权限校验，事务保留原任务和节点历史，新增代次从准备节点执行；同仓库仅允许 v6/v7 空方案升级一次到 v8，重复 requestId 幂等。先核对目标仓库已准入、实际等待原因及效果账，再调用一次；调用后回读任务 ID、代次、版本、当前节点及仓库读取工具结果。业务代码只能由插件任务流修改，本部署流程不得替它编辑业务仓库。

## 消息与任务工作流入口

S 节点只接收事项拆分所需的消息材料；群职责保留在持久快照，不进入 S 的 8 KiB 输入。背景预算遗漏项以来源键传给 S，指代需要时仍应请求相应材料。旧版因 S 输入容量被阻断、且尚无单元、节点、命令、请求或屏障的消息，启动恢复时只允许按 `s-compact-v1` 投影重试一次；部署后须逐条回读状态，不能将启动健康视作处理成功。
R 节点身份卡只携带本次明确引用的来源键，其他来源保留在 Host 召回数据并向模型标注省略数量；目标或判别事实过长时保存完整材料引用，选中候选须补取详情。任务历史可通过 `task-history:<taskId>` 或 `workflow-task-history:<taskId>` 在相应读权限下按需读取。至多八张身份卡的输入保护值为 14 KiB；明确引用超过八项或保护证据超限时进入可见阻断。旧版 R 容量阻断在无业务副作用且目标单元的材料请求均已解决时可恢复原节点；未解决请求不得重试。
I 节点接收完整群职责、事实、R 已解决的必要材料与限制，以及可用流程目录；输入保护值为 18 KiB。S/R/I 请求先冻结 system 与 message，再以实际请求字节检查本地保护值并复用同一内容发送；实际 token 仍以提供商 usage 回读。确定性节点不领取模型槽或模型额度。新消息先持久接收，再按控制账顺序一次处理一条；启动恢复沿用相同顺序，真正开始处理时才启动该消息的节点时间窗。渠道回读的自身发件按群和消息 ID 排除，不作为新业务消息；历史投影也排除这些回声。旧回声若没有业务命令，恢复时封存其等待请求，保留原记录。收发信箱合并新工作流账，只有通知独立回读后才显示已发送，撤回凭真实回执单独记录。

`workflow` 配置显式提供 `groupIds`、`dbPath`、`instanceId`、`artifactDirectory`、`ownerActorId`。控制库必须由独立初始化/迁移步骤建立；常规插件启动不建库、不自动封存旧群。

启动在恢复任何旧 Resident 之前回读每个指定群的控制账：必须 `message.group.state=active`、`engine=workflow` 且存在 `legacySealRef`；同时旧存储不得有未完成 Task、未归类消息、未完成协调请求或未结 Outbox。只有配置没有持久切换事实会拒绝启动。发送失败记录仍属于未结投递，不能删掉或标记送达来满足门禁。

验证 `/state/workflows` 的消息节点、命令和预算；`/state/tasks` 合并旧任务与 `engine=workflow-v2` 任务，进度直接来自 executionNodes。`/state/groups` 的收信箱、发信箱按群合并旧记录与新工作流的持久消息和通知，同一消息 ID 或通知 ID 只出现一次；新消息按实际发生时间排序，新通知仅在渠道独立回读后显示为已发送。已切换群不再恢复旧 Resident，也不能通过旧 Web 新建 Task 接口旁路创建；未配置群维持原入口。通知与任务运行分开：渠道 ACK 不能标记送达，必须拿到可信消息 ID 后独立回读正文和群。没有消息 ID 时保留未确认状态。

配置页部署后回读 `GET /state/workflows/catalog`：确认 `engine=workflow-v2`、目标群在 `groupIds`、消息阶段为接收／上下文／S／R／I／派发，任务流程的可发起状态、版本和节点来自当前注册定义。实际浏览器中确认已切换群只显示只读目录，不出现旧“任务流程提示词”编辑器；未切换群的旧配置仍可折叠访问。通用配置保存不得改写已切换群不用的 `taskPrompts`。

运行看板在真实浏览器中点击 `workflow-v2` 任务卡片，确认进入节点详情且排队任务也可查看；模型节点才显示所属会话记录入口。旧任务仍走原会话入口，任务卡片进度图标与折叠交互不变。

入口本地回归：`node --test test/workflow-entry.test.js test/http.test.js test/workflow-service.test.js`；原生 Runtime 防双入口测试：`node --test --test-name-pattern='已切换群' test/runtime.test.js`。测试不向真实渠道发送消息。

普通澄清通过 `POST /workflows/<runId>/requests/<requestId>/answer` 接收 `{eventId,answer}`，禁止传入 actorId。此接口沿用本机可信操作者边界，只接受 loopback 和许可的同源 Origin；不是远程登录鉴权。Host 必须显式配置 `workflow.webActorId` 映射本机操作者，缺失则禁写，不默认冒认 owner。请求仍检查 permittedActors 和原请求身份。钉钉答复必须引用已独立回读的澄清通知消息 ID，并匹配同群唯一请求；Web/IM 消费同一首终态，迟到冲突只读回原答复，不创建新任务。本接口不提供生产操作批准，生产 approval 意图在未实现相应审批流程时保持 unsupported。

历史上先被独立接收、后折叠为澄清答复的消息，由恢复通路核对原请求已解决、澄清通知已送达且答复引用该通知，再把答复来源补挂原话题并结清其归类屏障。回读该答复的 `routingStatus`、`intentStatus`、`message.topic.source` 和原业务 Task 数量；补挂不重新运行意图或任务。任一证明不唯一或缺失时保持原记录并报告恢复失败，不按文本相似度强行关联。

旧消息重处理通过本机 `POST /workflows/<runId>/reprocess` 逐条执行，要求 `workflow.webActorId` 已配置。先确认原运行没有任何业务命令；有命令时接口拒绝，不能绕过。事务保留旧运行及通知、封存未答请求，创建递增来源版本并重新取当前消息与任务上下文。对多条旧消息按原时间逐条调用，每条回读新运行及收发信箱后再继续，不能把原消息重复投给渠道入口。

审核问题的状态问句、数量补充与引用清单须按原发生时间依次回读 S/R/I：问句执行同群旧任务只读查询，数量说明记录为话题事实，引用清单收束为一次范围查询，不新建三个任务。查询应区分已完成且有 UAT2 交付标记的任务与已取消且无部署回执的任务。结果通知优先引用来源消息；发送 ACK 后从实际 `result.openTaskId` 取得投递任务并按同群、引用消息 ID 和正文独立回读。钉钉可能添加 @ 前缀或改写正文空白，引用通知回读允许空白归一化，正文差异仍不得标记送达。

进展查询验收：读取对应 `/state/workflows` 消息命令的 `result.flow`，应为 `task-progress-query@1`，节点顺序是 scope／candidates／readback／reply；`/state/tasks` 中不得因此新增业务任务。分别覆盖单任务、同群集合、无匹配、旧任务已取消与 UAT2 标记，回复不得把候选匹配当作已确认的问题归属。

群职责验收：从 `/state/groups` 核对当前群“会话职责”，日常查询及澄清通知的持久 `payload.text` 应按职责另起一段带 `- 小小鹏代回`，渠道引用的来源消息 ID 应与原消息一致。第三方“任务已创建，开始处理。任务：… — …”仅作为进展同步入站，运行应以 `message_quiet` 收束；此前误发的澄清需按真实渠道回执逐项撤回并记录，不再补发。

进展消息话题验收：静默结案与话题绑定分开回读。引用消息必须在同群已送达通知与来源消息链上证明唯一目标话题；有唯一证据时，`/state/groups` 的 `topicRefs` 指向该话题、`routingStatus=routed`，话题详情能回看进展消息。无证据或多话题时保持 `topicRefs=[]`、`routingStatus=pending`，不发回复也不建任务。启动恢复仅一次有界补录旧静默进展消息，不重跑 S/R/I。旧纯排查任务完成后再次收到同一问题报告，若未明确要求修复，须生成一次授权澄清并引用原消息；原提问者或已配置的任务所有者可引用该通知答复，其他群成员的引用按普通新消息处理，不能答复该请求或阻断群消息补拉。肯定答复后新建工作流任务，旧任务保持只读。旧消息重处理先核对原命令和通知，避免重复外发。通知首次准备时冻结正文；群职责变化后恢复扫描须复用已保存正文，不按新规则重写历史通知或阻断后续待发通知。

归一化回归两消息验收：先按原时间处理问题报告，再处理引用该报告且明确要求“小小鹏”修复的消息。R 补入旧任务历史后应在容量内完成关联，保留 `omittedCandidateCount`；首条仅沉淀话题，不把旧“单位不一致”修复误作本次归一化修复任务。第二条满足群职责的显式交办准入时才创建一个已登记仓库的工程任务，外部效果流程不因此开放给群成员。分别回读消息命令、话题及任务看板，不能凭模型接纳或发送回执宣称任务已经开始执行。

话题看板同时列出旧引擎话题和新工作流话题；收信箱的新消息从持久 `message_topic_bindings` 读取话题引用，不能填空数组。尚停在 R 节点取材料、没有确定话题绑定的消息继续显示待关联；不得凭相似标题硬挂旧话题。已确认的历史无命令消息可经 `docs/acceptance/message-reprocess/scripts/backfill-topics.mjs --check` 先校验，再在实例停止和备份后用 `--apply` 写入确定的话题事实；完成后独立回读话题列表和消息引用。

消息接纳在同一 SQLite 事务中保存话题版本、带源消息版本和原文的事实、单元归属及命令。纯话题事实也可成为后续关联候选；有效话题限制由 Host 加入任务输入，不依赖模型再次复述。S 使用代码计算的 UTF-16 片段边界和全文长度，I 参数为严格命名合同（创建/调研要求 objective，工程要求 repositoryId；I 不提交 workflowPlan）。Task 与 Owner 原子接纳后由 Owner 依据受信目录初始化计划。字段校验失败只重试原节点并提供错误位置；必需上下文超限明确进入 needs_attention，不能制造无法补齐的空材料等待。执行材料就绪前不接纳业务命令，材料恢复不重跑已成功 I。

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
4. 按现有 `scripts/start-web.ps1` 启动；后台 PowerShell 进程使用 `Start-Process -WindowStyle Hidden`。若使用 `DSH Web Local` 计划任务，先确认其输出重定向目标 `D:/project/dingtalk-dsh-assistant/docs/tmp/dsh-web-local/` 已存在，否则 PowerShell 在启动脚本前退出（本机曾返回 LastTaskResult=1）。stdout/stderr 只存本地 `docs/tmp/`，日志可能含登录链接，不进入 Git。
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

步骤产出与通栏排版更新也需安装两个插件。新增只读 `/state/tasks/{taskId}/runs/{runId}/nodes/{nodeRunId}/output?ref={outputRef}&cursor=0`，limit 默认 1200、上限 8000；仅返回业务 text、nextCursor、totalLength。服务端核对配置群、Task/Run/节点及输出引用；旧引用变更后拒绝继续分页。进入详情才读取，长文逐页追加，失败就地重试；原始工件对象不传给页面。在线回读既有节点正文与摘要一致，不为验收重跑业务任务。

任务状态映射修复需打包 Assistant：对无 Owner 且计划已 succeeded 的记录，回读 `/state/tasks` 为 completed/succeeded，结果原文及信息局限保留。已有 Owner 的验收和 waiting_confirmation 仍保持原门禁。该修复只读展示，不修改持久任务、不重跑流程、不补发消息；部署前实例已停止时保留停机状态，安装包回读不等于在线验证。

任务详情使用紧凑编号时间线：标题与耗时同排、产出按标签展开、进度条表示已完成步骤比例。节点产出补充材料正文、文件清单、变更和已记录检查结果；此次需同时安装 Assistant 与 Observer，沿用只读分页接口及既有备份/回读流程，无 schema 变更。

工程节点产出展示真实修改方案：replacements 显示目标文件及修改前/后内容，changes 显示完整文件内容或删除动作。保留分页，隐藏原始 JSON、校验哈希和工具参数；无须重跑历史节点。部署同时更新 Assistant 与 Observer，回读既有方案工件与页面接口内容一致。
