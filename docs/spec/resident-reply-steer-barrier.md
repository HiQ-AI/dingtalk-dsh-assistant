# 常驻主会话回复前的 Steer 语义门禁

## 现状与问题

群消息会先创建 pending Decision 请求，再通过 `agent.steer()` 进入常驻主会话。旧实现把整个 turn 的最后一段文本当成判断结果，也没有把模型看到的消息快照与回复可靠提交绑定：后续 Steer 既可能覆盖已经生成的结构化 Decision，也可能在旧回复尚未进入 Outbox 时到达而未被审阅。

这里不能用“只处理上一条消息”、关键词、相邻关系或固定时间窗替模型判断。一个 turn 内可以同时存在多个相关、部分相关和无关事项，协议必须保留模型表达这种关系的能力。

## 目标

- 常驻主会话提交任何非空群回复前，必须语义审阅当时已经 Steer 的全部普通群消息请求。
- 新消息影响当前回复时，由模型把相关请求放进同一 submission，并结合全部相关消息重新生成 Decision。
- 新消息是独立事项且已经判断完成时，由模型在同一次工具调用中使用独立 submission 提交。
- 新消息不影响当前回复且尚未处理时，模型只声明已观察；Runtime 先可靠提交当前回复，再保留该请求供下一 step 处理。
- Runtime 只校验审阅覆盖和提交顺序，不判断消息相关性。
- 门禁只作用于同群的“新 Steer 插入”与“当前回复可靠提交”竞争窗口，不串行不同群，也不把 Task 执行改成全局串行。

## Decision 工具协议

`group_decision_submit` 使用顶层 `observedRequestIds`：

```json
{
  "observedRequestIds": ["request-a", "request-b", "request-c"],
  "submissions": [
    {
      "requestIds": ["request-a", "request-b"],
      "decision": { "actions": [], "reply": "结合补充信息重新生成的回复" }
    }
  ]
}
```

当任一 effective Decision 含非空 `reply` 时：

1. `observedRequestIds` 必须与该群当前全部普通 pending 请求完全一致。
2. 出现在 submission `requestIds` 中的请求在本次调用内完成；相关请求共享一个 submission，独立请求使用不同 submission。
3. 已观察但未提交的请求表示模型判断它不影响本批回复且决定稍后处理；Runtime 不消费它，也不会再次 Steer，而是保留 pending 供当前 turn 的下一 step 处理。
4. 若已有新 Steer 进入 pending、但模型没有观察到，整批以 `group_decision_reply_observation_stale` 原子拒绝，不执行 Task 动作，也不写旧回复。
5. 门禁基于附件缺失拦截后的 effective Decision；原始 `reply` 为空但被转换成附件缺失提示时，同样必须完成全量审阅。

没有非空回复的 Decision 不要求观察全部 pending，请求可以独立完成，不被其他未处理事项阻塞。

## Task 通知工具协议

Task 完成或等待信息的群通知使用独立的 `group_reply_submit`：

```json
{
  "requestId": "task-reply-request",
  "observedRequestIds": ["request-c"],
  "reply": "任务结果通知"
}
```

- `[TASK_COORDINATION]` 每次创建一个独立回复请求，普通 assistant 文本和 turn 最终文本都不能完成该请求。
- `observedRequestIds` 同样必须覆盖提交瞬间的全部普通 pending；这些普通请求只表示已被通知候选审阅，仍保留给各自的 Decision。
- stale 时回复请求不被消费，Resident 可在下一 step 结合新消息重生成后再次提交。
- 工具只在通知可靠写入 Outbox 后返回成功。

## 提交与并发边界

1. 普通情况下，消息持久化、创建 pending、`agent.steer()` 连续执行。
2. 工具同步完成 schema、会话、群归属和观察快照校验；同一 JavaScript 执行片段内为含回复的提交取得同群 reply admission barrier，然后才结算请求。
3. barrier 存续期间，新到消息仍先持久化，但在创建 pending 和调用 `agent.steer()` 前等待，因此不会在“已完成观察”与“Outbox 可靠落库”之间插入一个模型尚未审阅的 Steer。
4. owner 完成 Task 动作并由 `store.appendOutbox()` 可靠写入回复后释放 barrier。等待中的消息随后获准进入 Steer；协议不额外承诺异步调用间的严格到达顺序。
5. 含回复的工具等待可靠 Outbox 后才返回成功。同一次调用存在多个回复时，所有回复均写入或明确失败后才完全释放 barrier。
6. 普通消息只有在 `steered` 投递状态可靠记录后，所属 submission 才能执行动作或写回复。即使模型先领取请求，状态落库失败也会拒绝提交并释放 barrier。

这里锁住的是同群两个事件的先后关系：`reply commit` 与 `next steer admission`。它不锁模型推理、不锁不同群、不锁无回复 Decision，也不把多个 Task 强制改成串行执行。

无回复 Decision 的工具可以早于动作提交返回，因此配置切换和退订必须额外等待该群 active submission 的 `committed`，再做最终 Task 状态复核。

## Recheck 边界

`GROUP_DECISION_RECHECK` 也可能生成回复，因此使用同一观察门禁。recheck 请求可以与确实相关的普通 pending 请求共享 submission；Runtime 强制由 recheck 作为 owner，外层原消息只执行一次合并后的 Decision，并统一结算全部普通来源、投递状态和 committed。recheck 不能在外层 Outbox 写入前提前完成。

## 生命周期与故障边界

- 历史导入、配置切换和退订等待 Resident 时，不占用群业务尾链或全局 Task 尾链；否则当前 Decision 可能需要相同尾链而形成环形等待。
- 订阅、配置切换和退订使用独立生命周期串行域。工作区替换在短 Task 提交段内最终复核 active Task；退订按统一的 `group tail → task tail` 顺序完成最终复核和持久化移除，再在锁外释放 Resident。
- 关闭 Runtime 时，先禁止新入口并释放 reply admission 等待者；尚未进入 Steer 的消息会明确失败。已开始可靠 Outbox 的 Decision 或 Task 通知则等待其提交完成。
- Outbox 持久化失败时，工具明确失败并释放 reply admission；普通 Decision 沿用 `decision-failed` 不自动重放，避免已经执行的 `task-context`、`task-reopen` 等动作重复发生。Task 完成通知没有绑定业务动作，Runtime 可按稳定结果键重新发起通知协调；首次完成使用无序号键，后续执行轮次使用 `completionSequence` 后缀。
- Outbox 已可靠落库后，live 或缓冲发送监听器异常只记录为恢复问题，不能反向把工具成功和入站 Decision 改写成失败；实际渠道投递继续由 pending Outbox 的回读与重试处理。
- 完成通知补发会跳过已经退订、没有群投递目标的历史 Task；单个订阅群 Resident 不可用时记录失败并继续处理后续 Task，全部尝试完成后再统一返回错误，不能让一个异常群饿死其他群。
- 该协议只保证当前进程内的线性化顺序。它不是跨进程事务，也不把进程崩溃窗口声明为 exactly-once；崩溃恢复仍依赖现有 Inbox、Outbox 和状态恢复机制。

## 验证要求

- 已有新 Steer 未观察时，旧回复整批拒绝且无副作用。
- 相关消息合并后只提交一条重新生成的回复。
- 不相关消息可只观察不消费；旧回复先可靠写入，新消息随后处理。
- 多 submission、部分相关与未提交请求保持模型可表达性。
- Decision claim 到 Outbox 的异步窗口内，新消息不能越过同群门禁进入 Steer。
- 无回复 Decision 不受全量观察门禁阻塞。
- 附件缺失转换出的 effective reply 不能绕过门禁。
- recheck 回复等待外层 Outbox，并可合并普通请求；合并消息的 `steered` 状态失败时不能发送候选。
- Task 通知必须通过独立工具提交，普通 assistant 文本不能冒充通知结果。
- 四条以上相关、部分相关、独立和仅观察消息可以在同批中组合表达，不退化成上一条消息的二元判断。
- Outbox 写入失败不产生成功回执并释放门禁；首次完成通知可按同一稳定键补发，发送监听器失败不反向否定已持久提交。
- 配置切换、历史导入和退订等待 Resident 时不占业务尾链；无回复 submission 也必须在生命周期最终提交前收口。
- 关闭会释放 admission 等待者，同时等待已经开始的可靠 Outbox 提交。
- 不同群互不阻塞；全量测试、打包和静态检查通过。
