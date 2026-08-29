# Running Task 常驻巡检

## 目标

持久 Task 为 `running` 时，插件持续保证其绑定的同一个叶子 Session 仍注册在 DSH `ctx.agents` 中，且该 Session 的原生 Goal 为 `active + armed`。外部进程、请求或宿主异常不得让 Task 只在看板上保持运行、实际执行却停住。

Task 只有两类合法等待：向原群任务提出人补充目标信息，或向真人请求处理叶子无法自行解决的外部异常。除此以外，叶子不得结束、暂停 Goal 或把 Task 置为 waiting。

## 设计

- 以持久 Task 状态作为业务事实，只巡检 `running` Task。
- 以 DSH Agent Registry 判断 Session 是否仍存活；`agent.status === idle` 是正常检查点，不等于 Session 停止。
- Session 已离开 Registry 时，通过 `ctx.agents.resume()` 恢复原 `childSessionId`，不新建 Task、不更换逻辑叶子。
- Goal 为 `paused`、`blocked` 或 `active + disarmed` 时，通过 `ctx.goals.resume()` 恢复；Goal 缺失时在原 Session 创建同一 Task 目标。
- Goal 异常发生时若 Agent 仍为 `running`，等待其进入 DSH 原生 idle 检查点后再恢复，避免在 blocked closing step 中途改 revision 或打断当前 turn。
- Goal 的 `roundsStarted >= maxGoalRounds` 且已进入 `blocked`、`paused` 或 `active + disarmed` 时，执行预算已经确定耗尽，不再依赖可能残留的 Agent `running` 状态，也不自动重建新 Goal；Runtime 立即把 Task 转为 `waiting/human-intervention`，附带 Goal 轮数、阶段、Session 和 Agent 状态，避免看板假运行并释放并发名额。
- 真人处理阻断问题并明确恢复后，Runtime 若发现原 Goal 轮数已经耗尽，先把 `maxGoalRounds` 增加一组默认预算，再使用编辑后的 Goal revision 执行 resume，确保同一 Task 和 Session 能实际继续运行。
- 恢复后必须重新读取并断言 Session 已注册、Goal 为 `active + armed`。
- 每次异常及恢复失败写入现有 Supervisor 去重告警；除 Goal 轮数已确定耗尽外，Supervisor 不修改 Task 的业务状态。
- `waiting` Task 表示真实缺信息或缺授权，不参与自动恢复。
- 使用定时巡检补充 DSH 生命周期事件；不复制 Session、Goal 或 Goal Round 状态机。
- DSH 启动进程沿用系统 `TEMP/TMP`；临时目录不能放在 Agent 工作区内部，否则 Codex Connect 的工作区隔离会在命令启动前拒绝执行。

## 合法阻塞分类与路由

### 目标信息阻塞

仅当目标、完成条件或任务提出人掌握的必要业务信息不明确时使用：

1. 叶子提交结构化 `information` 阻塞，必须包含具体缺失信息和可直接回答的问题，不接受泛化的“请补充上下文”。
2. Runtime 将 Task 置为 `waiting/information` 并阻塞原生 Goal。
3. resident 主会话收到 Task ID、原群、任务提出人稳定 ID、问题清单和已取得的证据，由主会话在原群与该提出人沟通。
4. 群聊答复通过 `task-context` 精确追加到原 Task；Runtime 恢复同一 Session 和 Goal。

### 真人处置阻塞

仅允许以下叶子已尝试且自身无法解决的外因：操作红线、网络中断、磁盘空间不足、计算或进程资源不足、执行意外事件，以及必须由真人确认处置方案的事项。

1. 叶子提交结构化 `human-intervention` 请求，必须包含分类、现场证据、已尝试动作、不能自行解决的原因和希望真人回答的具体问题。
2. Runtime 将 Task 置为 `waiting/human-intervention`，阻塞原生 Goal，并生成稳定阻塞请求 ID。
3. 插件向 DWS 登录人的“本人私聊窗口”发送消息，正文携带 Task ID、阻塞请求 ID、目标、原因、证据和所需答复；先持久记录发送任务 ID，再查询并记录真实 `conversation_id` 与 `message_id`。
4. 本人发出的消息会被个人 IM 事件流 self-loop 过滤，因此插件按固定间隔增量回读该单聊窗口；只接受引用该 `message_id` 的新消息，以引用消息 ID 去重并精确关联 Task。普通私聊和未引用回复不能恢复 Task。
5. Runtime 把真人答复追加到原叶子，恢复同一 Session 和 Goal，并将 Task 改回 `running`。
6. 真人处置等待不设置超时时间；不得因等待数分钟或数小时自动失败、自动完成或创建替代 Task。Runtime 重启后继续使用持久的会话 ID、阻塞消息 ID 和轮询游标等待，直到匹配引用回复或用户明确关闭任务。
7. Runtime 对 `blockerCategory + 规范化 requestedAction` 计算稳定范围指纹，并把阻塞及批复写入 Task 历史。同一待批范围重复提交时复用原阻塞请求，不得再次外发；同一范围已经批准时直接恢复同一 Task 并向当前叶子重放批复，不得再次申请。只有范围指纹变化才允许创建新阻塞；物理叶子替换或 Runtime 重启不得丢失已批准范围。

### 非法阻塞

代码错误、命令失败、可重试的网络波动、可清理的本任务临时资源、普通不确定性、实现困难或仍有安全范围内替代路径时，叶子必须继续诊断、修复或重试。Supervisor 发现 `running` Task 的 Goal 非法 paused/blocked/disarmed 时，在 Agent idle 后恢复，并把阻塞事实作为纠偏上下文投递给同一叶子。

## 本人私聊窗口契约

真人就是当前 DWS profile 的登录人。发送目标使用该 profile 的当前 `user_id`，不得按显示名猜人。发送后必须通过 `openTaskId` 查询真实 `openConversationId/openMessageId`，并持久记录发送时间；轮询固定使用该 `openConversationId`，只完整读取 `[阻塞消息发送时间, 本轮时间)`。时间窗结果不完整时保持等待并在下轮重查，不得把 partial 当作没有回复。事件订阅不能替代该轮询，因为 DWS 会过滤当前用户自己的消息。

## 验收

1. `running` Task 的 Goal 被外部暂停后，下一轮巡检恢复为 `active + armed`。
2. `running` Task 的 Agent 从 Registry 消失后，下一轮巡检恢复同一 Session ID。
3. `waiting` Task 的 blocked Goal 保持不变。
4. 恢复行为产生去重 Supervisor 告警，Task 状态始终不被巡检推进。
5. Goal 轮数耗尽时，即使 Agent 状态持续为 `running`，Task 也必须转为 `waiting/human-intervention`，不得继续显示运行中或自动获得新一组轮数。
6. Goal 轮数耗尽产生的阻塞经真人处理并恢复后，Goal 必须增加一组轮数预算并进入 `active + armed`。
7. information 只能经原群提出人答复恢复；human-intervention 只能经真人引用对应私聊阻塞消息恢复。
8. 本人私聊发送后取得真实会话和消息 ID；只有引用该消息的新回复能恢复对应 Task，重复轮询不重复投递。
