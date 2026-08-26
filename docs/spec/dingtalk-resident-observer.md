# 钉钉群聊 Resident 只读运行看板

## 目标

在 DSH Web 中提供独立于插件配置页的只读运行看板，展示常驻群、resident 主会话、Task、叶子执行活动和 Supervisor 告警。看板只消费 `dingtalk-dsh-assistant` 已有的只读状态接口，不持有运行状态，也不提供配置或任务操作。

## 边界

- `dingtalk-dsh-assistant` 仍是群订阅、会话绑定、Task 和告警状态的唯一所有者。
- 展示扩展只发起 GET 请求；不调用 `/config/*`，不复制 Task 状态机或 Supervisor 判断。
- 使用 DSH 原生 `sidebar.footer.action` 提供入口，使用 `shell.overlay` 呈现独立页面；不替换会话区和侧栏。
- resident 不可达时明确显示连接失败，不以缓存数据伪装当前状态。

## 页面

- 页面不重复展示 Resident、消息通道、常驻群、活动 Task、告警等全局指标卡，直接进入当前页面内容；连接错误仍以内联错误卡呈现。
- Header 主导航：在标题与页面操作之间放置“群聊会话”“任务看板”“归档任务”，默认进入群聊会话；不单独占用第二行。
- 群聊消息：使用单一只读表格列表；通过群聊会话下拉框切换消息来源，按时间倒序、每页固定 10 条，提供上一页/下一页。每条展示发送人、发送时间、正文、序号、消息 ID，以及 resident Agent 投递状态。
- Agent 投递状态来自 Runtime 持久化事实：`delivered`、`failed`、`pending`、`skipped` 分别展示为已投递、投递失败、投递中、历史补拉未投递；旧数据没有状态字段时展示“历史状态未知”。
- Agent 发件箱：在入站群聊消息下方按持久化顺序倒序展示 outbox，每页固定 10 条；展示消息正文、来源消息 ID、回复目标、真实投递消息 ID 和 Outbox ID。`pending` 展示“待回读确认”，只有完成钉钉回读并持久化真实 messageId 的 `sent` 才展示“已回读确认”；outbox 没有发送时间字段，因此页面不推测发送时间。
- 历史状态只允许通过显式确认调用群级回填接口补齐，默认仅更新缺少状态的消息，不覆盖 Runtime 已记录的失败、投递中或未投递状态。
- 历史补拉按稳定 messageId 去重；重复消息允许只补齐缺失的 `senderName` / `senderOpenDingTalkId`，不得覆盖已有发送人，也不得重新触发主会话判断。
- Agent 使用本人账号发送群消息后，将回读得到的真实 messageId 持久化到 outbox；后续历史补拉按同群 messageId 在附件处理和 Agent 判断前过滤。若钉钉消息先于发送回读进入补拉，则仅在发送人是当前 DWS 用户且正文/引用与 pending outbox 匹配时确认该 outbox 并过滤，避免把 Agent 回复重新当作入站消息，同时不按发送人身份宽泛过滤本人手工消息。
- 任务看板：固定展示 `queued`、`running`、`waiting`、`completed` 四个状态桶，即使为空也保留；状态桶使用统一的 720px 实际外框高度和更宽列宽，卡片区独立纵向滚动，避免任务增多时持续撑高整个页面。每个 Task 是一张卡片，展示目标、来源群、Task ID、叶子 Session、更新时间和当前状态摘要。Supervisor 告警随任务看板展示。
- 归档任务：只展示 `completed` Task，按更新时间倒序排列。
- 任务看板复用 ScrumWS 的状态浅底列、实心状态胶囊、白底数量和任务卡片信息层级，只复用展示范式，不复用其状态与操作逻辑。
- 浅色与深色分别跟随 DSH 主题变量渲染卡片面、边框、文字、阴影和语义状态混色，不维护一套固定色板。
- 群聊会话：每个群是一张 resident Session 卡片，展示群名称、群 ID、消息数和最近消息时间。
- 告警：类型、Task、次数、最近发现时间和详情。

## 会话与轨迹导航

看板不重新读取或渲染 Session JSONL。点击 resident 卡片时调用 DSH 原生 `ctx.sessions.open(residentSessionId)`；点击已有叶子会话的 Task 卡片时，先通过 `ctx.sessions.refreshSubagents(parentSessionId)` 刷新原生子会话目录，再使用 `subagentAddress` 和 `openSubagent` 打开。看板随即关闭，用户在 DSH 原生会话页的“对话 / Trajectory”标签间查看完整内容。

`queued` Task 只有预分配的确定性 Session ID，Runtime 尚未创建物理叶子会话，因此卡片保留可见但明确显示“等待执行，尚无对话和轨迹”，不伪造 Session。

页面打开时立即加载，并每 5 秒刷新；关闭后停止轮询。所有数据来自 `/health`、`/state/groups`、`/state/tasks`、`/state/activities` 与 `/state/supervisor/alerts`。

## 验收

1. DSH Web 侧栏底部出现“运行看板”入口。
2. 页面能看到当前常驻群及其 resident Session，点击后打开 DSH 原生会话。
3. 四个任务状态桶始终可见；Task 卡片能关联叶子 Session，点击非排队卡片后进入原生对话页并可切换 Trajectory。
4. 告警为空和非空都有明确呈现。
5. 扩展代码及浏览器网络请求不包含 POST、PUT、PATCH、DELETE 或 `/config/`。
