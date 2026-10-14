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

普通代码更新保留同一数据库、初始化标记、instanceId、epoch 和原会话目录，不重复清洁启动。当前任务会话运行时没有旧 workflow maintenance 接口，不能直接使用依赖该接口的历史部署脚本。停机前须通过当前宿主的原生生命周期停止接纳并排空，确认原任务/执行/群会话及实际业务子进程已结束；不能仅凭一次 SQLite 快照声称原子排空。普通本地部署不备份历史副本。

本机静止实例使用 [原生退出切换脚本](../acceptance/task-session-runtime-repair/scripts/deploy-task-session-native.ps1)：显式传入持久 Assistant 与 Observer 两个包及各自摘要、精确旧 PID、当前 profile 摘要及本轮证据目录，先 `-Check`，通过后同参数执行。脚本先核验共享控制台仅包含精确计划任务进程树，再经 Windows CTRL+C 触发 DSH 原生 SIGINT disposal；等待旧进程退出、SQLite owner 释放、原生日志回合结束和实际子进程退出后，才沿官方 `dsh plugin --profile web add` 安装。不修改 profile，核验其原字节摘要并还原自启状态，经计划任务启动并回读。失败保留现场与阶段记录，不自动强制重启；不得将其用于活动业务执行或其他实例。此脚本只支持既有已配置的本机身份与路径，不承担迁移。

恢复后核对包 SHA256、安装版本、新进程及健康，再分别核对收信箱、原通知及原任务。通知的 `openTaskId` 查询 SUCCESS 后仍须读取精确原消息核对群、发送者、原生引用及完整正文。DWS 缺少原生 mention 元数据时仅在这些精确发送证据齐全的情况下确认送达，并记录 `mentionVerification=unavailable`；不能把文本 `@姓名` 当作原生 mention 证据。unknown 不重发。

启动时 active、已排空、lastDecision=wait、无 question 且有 unknown 操作的任务，按相关运行模块摘要和当前需求/控制版本补一次 `runtime.updated` 唤醒。重复定时恢复或同代码重启不再补发；暂停、取消、人工问题等待和仍有执行的任务不适用。Owner 沿原任务调查并使用 `task_operation_reconcile` 核验，未知操作未被证明前不能放行原动作。

## 回退

新旧服务不得并行消费并执行同一群消息。需要回退先停新监听/外发与实际执行，保留新数据库、初始化标记、日志及真实外部效果证据，再按审阅后的旧实例配置恢复。清洁启动没有把新任务转换成旧工作流，不能恢复旧服务后自动重放新任务。旧数据的可恢复隔离与删除授权是两回事，不执行永久清理。

任务与动态执行会话直接使用配置的原生工具，不添加工具白名单；readOnly/readbackOperationId仅用于关联原操作调查与对账材料，不用工具种类代替事实核验。原生权限、来源版本、真实生命周期及未决效果账继续按实际状态判断。即使Observer源码没有变，也必须显式提供当前已核验的ObserverPackage及摘要：官方安装会重新解析profile既有overrides，单独安装Assistant可能回退Observer。两个包均经源码/安装读回核验。

统筹更新核验需区分新增Host输入与整个模型请求。检查原生surface仅保留当前完整Host快照、原审计输入仍存在、执行previousExecutions不递归。对模型过载查看本lease的turn/end：临时过载保留wake，按现有retryIntervalMs退避后续办同会话，不把其写为业务blocked；旧版误blocked仅凭原生日志精确识别恢复。看板中统筹等待尚在执行的小目标仍为执行中。
