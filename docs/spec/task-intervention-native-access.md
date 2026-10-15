# 任务引用、人工介入与原生能力

目标：回复正文不重复钉钉原生引用；技术/插件/宿主阻塞在 Web 人工介入或当前 DWS 登录人的私聊处理，需求提出人仅接收必要业务信息问题；原生任务执行不再被插件额外文件边界或跨操作全局锁阻断。

现状与证据：协调模型生成了前置 Markdown 引文，出口仅处理署名；新 task-session 将任何 question 直接 queueReply 到任务原发起群。旧 dws-bridge 的私聊监听及引用恢复仍存在，但其分支只识别旧 humanBlocker/workflow-approval，新 taskSessionRequest 不满足旧任务查询条件。execution-session 虽给动态执行 danger-full-access 并绕过工具白名单，仍安装 guardTaskFileSystem，禁止任务 .dsh 日志及其他任务目录；nativeOperation 与 SQLite operation.start 各自设置任一 unknown 的全局阻断，并给缺少并发元数据的工具分配 host-native-operation 全局锁，导致 gh/pwsh 只读调查无法执行。

方案：提示明确禁止复述被引用原文，格式器仅去除与受信来源一致的前置引用，保留其他引用证据。人工申请按 audience=requester/operator 明确分流，缺省 operator；operator 请求持久保留于现有 Web 面板，私聊沿既有原生通知账及 sendSelfIntent/独立回读，身份取当前登录账号而非任务提出人。现有私聊事件和轮询处理 taskSessionRequest，要求精确通知引用、私聊会话、真实发送者和当前申请版本；群补充不得作为 operator 问题的答复。

去掉动态任务的附加文件拦截、原生调用全局 unknown 门禁及合成全局资源锁，继续沿原生 preset/sandbox/approval 执行；保留原操作身份去重、真实未知记录、任务版本、取消排空与业务完成证据。旧未知结果不会通过本次修改伪装为成功。

验证：重复来源引文与合法引用反例；业务问题、Web-only 技术申请、私聊发送/回读/精确引用恢复、错误作者/群/引用/过期版本拒绝；真实原生 gh 调用及任务日志读取在已有 unknown 时可用，原未知账保持。定向回归、精确包部署及目标任务恢复分别取证。PR #175 已合并，新分支基于最新 main，不向已合并分支推送。

## Web 处理后的私聊通知撤回

Web 的 `task.human.respond`（含原生失败结清复合命令）成功提交、申请为 `answered` 且 `replyChannel=web` 后，通知调度独立回收该申请的 operator 私聊通知。关闭页面弹窗、检查答复、私聊答复及 requester 群通知不触发撤回。关联必须同时满足通知的 taskId、humanRequestId、kind=question、audience=operator 与独立送达回读保存的 messageId/conversationId/senderActorId，不能通过正文近似匹配选择撤回对象。

复用现有 `dynamic_notifications` SQLite 命令账、调度/恢复和错误记录机制，撤回另记 `notification.recall` 状态、尝试次数、领取 token、下次尝试时间及脱敏错误。领取有效期 5 分钟，进程重启后到期重新回读；同申请并发领取只允许一个执行者，迟到 token 不能覆盖当前结果。先读精确私聊完整历史；消息仍在且作者相符才调用现有 DWS `chat +messages-recall --msg-id <messageId> --format json --yes`，要求 `recallStatus=SUCCESS` 并再次完整回读确认消失。恢复时若完整历史已无该消息，记录目标已不存在的证据，不再次外发撤回。历史不完整、作者不符、拒绝、未确认或仍可见均记失败并退避重试；申请答复与任务恢复不回滚。发送与 Web 答复竞争时，发送回执仍入账，后续轮询待确认送达后再回收。

`listAuthorizationRequests()` 的 `notification.recall` 提供独立读取状态，`failed` 不等于人工申请未处理。没有通知、尚未确认送达或通知属于其他申请/群聊时不会冒用未知 ID。

接口证据边界：本次沿用仓库已存在的 DWS adapter 与 workflow-approval 撤回命令/成功确认契约；隔离环境未安装 DWS，未执行任何真实发送或撤回。官方网页检索未取得 DWS 撤回的权威时限与消息类型限制，因此没有假定两分钟、一天等时限；平台实际权限、账号及时间窗口拒绝作为真实失败保留。真实平台验收需在另行授权的测试账号和专用消息完成。
