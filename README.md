# DingTalk DSH Assistant

基于 DeepSeek Harness 的独立群聊常驻 Runtime。这里不依赖 Agent Studio，也不承载任何个人数字分身命名；实例身份与行为规则由工作区 `AGENTS.md` 和后续群配置提供。

当前实现包含自定义 dsh profile、单一通用 `dingtalk-group-assistant` 业务插件、唯一项目根标记，以及持久群订阅、ingress 去重排序、dsh resident Session create/resume、结构化群决策、可靠 outbox、持久 Task 四桶投影、独立 leaf、Supervisor 和授权审批状态机。Web 与 resident 由同一个 DSH Web 进程承载，避免两个进程并发写同一 Session JSONL。仓库模板默认关闭 DWS 消费与写入，安装后通过插件配置页面完成 Agent、群聊和连接配置。

Task 已从 scheduler 的共享数组迁移为 storage-domain 独立 KV 表中的单 Task 记录；scheduler 只保留 Agent 配置。群消息决策、Supervisor 与配置保存并发发生时，不再存在整组 Task 被旧快照覆盖的路径。

DWS live consumer 不回环当前登录人自己发送的群消息，因此同一 bridge 每 10 秒按各群最后持久消息时间执行增量补拉，并保留 30 秒重叠窗口覆盖短时乱序与边界消息。补拉仍进入同一持久 ingress；命中已有 `messageId` 时在附件下载和 Agent 投递前跳过，不新建第二套消费者。

叶子结果给 resident 的协调信封只投影面向群聊所需的摘要、提出人和交付/缺信息字段，不附完整 evidence 与 artifacts。Runtime 启动恢复期间先于 DWS bridge 产生的本进程 outbox 事件会在监听器挂载后补交；跨进程启动只重试已核验完成的 Task 通知，并通过 DWS 回读幂等去重，不重放历史普通回复或旧阻塞消息。

## 本地运行

```powershell
Set-Location <仓库检出目录>
npm run profile:install
npm run profile:dump
npm start
```

默认监听 `127.0.0.1:18998`。`GET /health` 只返回本地运行状态。退出用 `Ctrl+C`，由 dsh 启动器统一释放 Cordis 生命周期。

`scripts/start-web.ps1` 使用当前用户的 `%USERPROFILE%\.dsh` 作为默认 `DSH_HOME`，也支持调用前显式设置 `DSH_HOME`。脚本从当前项目根启动，不依赖固定检出目录。

Runtime 冷启动恢复时以持久 Task 状态为业务事实：`running` Task 若对应原生 Goal 因宿主退出或工具进程中断遗留为 `paused`、`blocked` 或 disarmed，会恢复同一叶子 Goal；`waiting` Task 不会自动唤醒。外部故障不创建新 Task，也不伪造业务 waiting/completed。

Runtime 运行期间还会默认每 5 秒巡检一次 `running` Task：叶子 Session 必须仍注册在 DSH Agent Registry，原生 Goal 必须保持 `active + armed`。Session 停止时恢复原 `childSessionId`，Goal 暂停或停用时调用 DSH 原生 resume；异常写入去重 Supervisor 告警，但不擅自改变 Task 业务状态。DSH Agent 的 `idle` 是 Goal Round 之间的正常检查点，不作为停止判据。

叶子只允许两类持久等待：`information` 由 resident 主会话回原群向任务提出人询问；`human-intervention` 用当前 DWS 登录人的本人私聊窗口发送结构化阻塞消息。后者不设超时，插件每 30 秒串行回读同一会话，只有引用真实阻塞 `messageId` 的答复才恢复原 Task、Session 与 Goal。其他错误必须由叶子继续诊断、修复或重试。具体任务流程和完成证据不在插件中固化；Agent 配置提供“任务流程引导”和“完成证据要求”两项自由文本，只通过动态 `systemPrompt.section` 注入叶子会话。Runtime 仅要求 completed 结果具备非空摘要和至少一条可核验证据。Goal 或 turn 先结束但未提交结构化结果时，Supervisor 先恢复同一 Session，要求按配置引导补齐结果，不立即丢弃已完成工作并新建叶子。

图片消息或紧邻图片的短说明被主会话初判为 `ignore` 时，Runtime 在存在活动 Task 的前提下执行一次关联复核；群友提供的未经核验根因或状态判断作为叶子需要核验的 Task 上下文，不因尚未证实而丢弃。正在正常运行但耗时较长的外部流水线以及 Goal 轮数耗尽不属于真人阻塞：Host 续接 Goal 并保持 Task 执行，`network/resource` 类型结果若只要求“继续等待/监控”会被拒绝。

dsh Web 使用 `scripts/start-web.ps1` 启动。脚本要求当前 `PATH` 中的 Node.js 主版本不低于 24，并从全局 npm 模块目录发现 dsh 启动入口。若插件配置或用户环境提供 `HTTP_PROXY`，脚本会同时注入大小写 `HTTP_PROXY`/`HTTPS_PROXY`，供 Codex Connect 访问模型服务；不需要代理的网络环境可以留空。

离线测试接口仅供验收：`POST /test/subscriptions`、`POST /test/inbound`、`GET /test/state?groupId=...`、`POST /test/outbox/ack`，以及 `/test/tasks` 下的 create/list/followup/wait/resume/complete/approval 和 `/test/supervisor` 下的 probe/alerts。任务识别由 resident main 的结构化 dsh turn 完成，不信任 transport classification。正式 resident 使用 dsh 标准用户级 `DSH_HOME`：状态保存在 `%USERPROFILE%\.dsh\storages\dingtalk-group-assistant\`，Session 日志与 Web 共用 `%USERPROFILE%\.dsh\sessions\` 的原生投影。Web 与 resident profile 统一使用未压缩、未打包的 JSONL；仓库内 `.dsh/` 仅保留迁移前副本和验收数据，不再作为正式运行入口。

真实适配开关位于 profile 的 `dws.enabled` 和 `dws.writesAuthorized`。首次安装保持关闭，完成 dws 安装、登录、群配置与只读验证后再启用写入。

所有真人介入统一使用 Task 的 `human-intervention` 阻塞。叶子必须单独提交 `risk`，Runtime 先创建一条持久授权申请；运行看板“授权审批”和钉钉本人私聊是两个共享同一申请状态机的批复通道，DWS 仅作为上层通知适配器。本人私聊申请按任务目标、阻塞信息、风险、现场证据、已尝试和审批范围分段展示；发送后会有限轮询 DWS 的异步发送状态，拿到真实消息 ID 后才进入 `waiting-reply`。网页或钉钉引用回复的首个明确“批准/拒绝”原子写入终态并恢复同一 Task/Goal，第二个通道不能覆盖；网页先批复时停止私聊轮询，若消息已在发送竞态中落地则通过 DWS 撤回并记录结果。决定、来源、回复原文、引用消息 ID 和规范化操作范围指纹作为 Task 审批历史持久化，不依赖当前物理叶子 Session，也不会被后续阻塞覆盖；相同待批范围的重复上报复用原请求，相同已批准范围的重复上报直接恢复执行，只有操作范围实质变化才创建新申请。替换叶子会通过系统提示继承已持久化批复。该闭环不依赖 Approval Server、独立审批号或内存等待进程，等待不设超时。

群消息形成的 Task 必须保留真实发起消息和发送人。完成通知由 Runtime 使用 DWS 原生引用回复并传结构化 `atOpenDingTalkIds`；正文不手写 `@姓名`，避免 DWS 自动渲染后重复 @。签名属于 resident 主会话的表达机制：Runtime 只在协调提示中要求 Agent 自己按工作区规则输出，不修改 Agent 生成的正文。Web 恢复历史 Task 时可传 `sourceMessageId`，Runtime 只从已持久化群消息派生提出人姓名与 OpenDingTalkId，不接受手填身份。

dsh Web 的「钉钉群聊个人助理」页签由同一插件的 `dsh.client` contribution 提供。页面可回读 Runtime 状态和 `dws` 安装/登录状态，可按群名称模糊搜索并添加常驻群，也可编辑群聊会话职责或删除常驻群。Agent 配置卡通过一个“保存配置”按钮原子提交 Agent 名称/别名（英文逗号分隔）、工作区、默认模型/推理深度、resident 网络代理、任务流程引导和完成证据要求；这些配置持久化在插件自身的 DSH storage domain，重启后仍保留。一个个人助理 Agent 只配置一个工作区，所有群 resident 主会话和新建叶子统一使用该绝对目录，`AGENTS.md` 由 dsh 原生发现；工作区变化只在无活动 Task 时执行，并保留各群已完成历史后重建 resident Session。所有 resident 与叶子 Session 在创建或恢复时统一选择 DSH 原生 `danger-full-access` 权限 preset；敏感操作统一进入插件的真人阻塞闭环。群职责允许主会话按介入条件主动沟通，但 `new-task` 还必须由当前消息明确指名已配置的 Agent 名称/别名、当前 DWS 登录人，或使用 `cc:`，且事项在职责范围内。明确指名只决定能否建 Task，不扩大动作授权；诊断请求不得扩写为修复任务。职责、稳定决策协议和动态全量 Task 关联索引通过 dsh 原生 `systemPrompt.section` 注入对应 resident Session；queued、running、waiting、completed 及产品展示中的归档任务均参与关联判断，状态只决定关联后的动作。对已完成结果提出回滚、撤回、还原、纠正或补做时，主会话返回 `task-reopen`，Runtime 重新打开原 Task、恢复原叶子 Session 和原生 Goal；不会只做口头承诺，也不会创建重复 Task。普通群消息只写入中文消息信封，不再把 Task 列表重复写进每条历史。DWS 图片先下载到系统 TEMP、读取后立即删除临时文件，再由 DSH attachment service 持久化并作为原生 image block 与消息共同送入固定主会话。引用消息只向 Agent 信封保留 DWS 当前事件已携带的引用消息 ID，不额外查询，也不注入引用发送人、时间或正文。Task 记录发起消息 ID、提出人姓名和 OpenDingTalkId；完成 outbox 使用 DWS 原生引用回复发起消息并真实 @ 提出人。Web 中的 resident 主会话同时注册三个 DSH 原生 Task 工具；主会话只负责沟通协调，创建后的工作由独立叶子 Session 和原生 Goal 执行。

运行看板顶部包含“群聊会话 / 任务看板 / 归档任务 / 告警”四个页面。Supervisor 告警具有 `active/resolved` 生命周期：巡检失败和 DWS consumer 退出先进入当前异常；载体恢复健康或 consumer 重新 ready 后自动关闭。Goal 恢复和叶子 Session 替换本身属于恢复记录，直接进入已恢复历史，不再以红色当前异常展示。告警按消息通道、叶子会话、任务目标和运行时分类筛选；已恢复历史每页展示 10 条。

独立的 `dingtalk-group-observer` Web 扩展使用 DSH 原生侧栏底部入口和全局 overlay，展示常驻群、resident Session、Supervisor 告警，以及按待执行/执行中/等待中/已完成划分的 Task 看板。点击常驻会话卡片会通过 `ctx.sessions.open` 进入 DSH 原生会话；点击已创建叶子的 Task 卡片会立即显示打开反馈，必要时刷新父 resident 的 subagent catalog，再通过 `openSubagent` 进入同一原生会话。Task ID 与 resident Session ID 可显式复制。completed Task 可调用 resident 的本机归档接口设置 `archivedAt`；归档不删除 Task、Session、Goal 或上下文，主会话后续仍可关联并通过原有 `task-reopen` 清除归档标记、唤起原叶子继续执行。排队 Task 尚未创建物理叶子，卡片明确显示无对话和轨迹。DWS 实时事件和历史补拉在进入 resident 前统一保留发送人显示名、`openDingTalkId` 与发送时间；主会话收到的决策信封会显式包含这三项，而不是只收到消息正文。

启动脚本要求 Node.js 24 或更高版本；较低版本缺少 dsh Session JSONL 持久化所需的 zstd API。

叶子任务并行上限属于 Agent 配置，默认 5，可配置为 1–50。提高上限后调度器按 FIFO 启动待执行任务；调低上限不会打断已经运行或处于业务等待中的原生 Session/Goal。

授权审批表格可通过“查看申请单”查看任务目标、阻塞原因、风险、现场证据、已尝试、完整申请范围、关联信息和批复结果。

resident 启动后会按群和消息序号恢复持久化为 `pending` 的群消息；已处理的重复消息仍按 messageId 去重，只有上次进程退出时未完成的消息会重新进入固定主会话处理，避免永久停留在“投递中”。

Task 叶子 Session 使用 DSH 原生 `subagent/descriptor` 投影登记；新建及恢复旧叶子时都会补齐 descriptor，避免 Web 将有效会话误报为“会话记录损坏”。

任务卡片进入对话后会立即释放临时导航状态；返回并重新打开任务看板时，同一卡片仍可再次进入对话。
