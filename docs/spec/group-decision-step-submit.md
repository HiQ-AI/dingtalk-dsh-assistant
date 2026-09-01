# 群消息 Decision 按 step 结构化提交

## 现状与根因

群消息先通过 `agent.steer()` 进入常驻 Session，Runtime 随后再发送 `[GROUP_DECISION]` coordinator followup，并等待整个 Agent `whenIdle()`。`coordinatorReply()` 从完成 turn 的 assistant 文本中提取 JSON。一个 turn 可被后续 Steer 扩展为多个 step，因此 turn 级最后文本既不能标识某次判断，也不能表达多个判断的独立归属和提交时点。

## 目标

- 模型在处理完成时立即通过结构化工具提交 Decision，不等待 turn 结束。
- 一次提交可覆盖一个或多个待判断请求；模型自行决定相关、部分相关或无关消息如何组合。
- Runtime 不按消息顺序、关键词或固定窗口推断关系，只维护请求归属、一次性提交和副作用幂等。
- 普通 assistant 文本、后续 step 和 turn 最终文本均不能被误解析成 Decision。
- 保持每条群消息即时 Steer，不改为 followup 排队。

## 协议

每条 `[GROUP_MESSAGE_STEER]` 增加一个不可猜测的判断请求 ID。Resident 可调用 `group_decision_submit`：

```json
{
  "submissions": [
    {
      "requestIds": ["request-a", "request-b"],
      "decision": { "actions": [], "reply": "..." }
    },
    {
      "requestIds": ["request-c"],
      "decision": { "actions": [], "reason": "..." }
    }
  ]
}
```

同一 submission 中的请求共享一个 Decision，只执行一次业务副作用；Runtime 选择其中最早持久化的消息作为确定性提交 owner，并把全部来源消息作为证据传给 Task。不同 submission 独立执行。一个请求 ID 只能被接受一次，跨群、未知或重复 ID 会原子拒绝，不产生部分提交。

## 调用与提交流

1. 持久化群消息并创建 pending request。
2. 将 request ID 与原始消息一起立即 `steer()`。
3. 模型在任意 step 调用 `group_decision_submit`，可以一次覆盖当前看到的多个 pending request。
4. 工具仅结算结构化判断，不直接执行 Task 或发群消息。
5. pending 等待不进入串行区；不同 submission 可按实际完成顺序独立继续。只有 Task/Outbox 等共享状态的短提交段按群串行，共享 Decision 仅由 owner 执行一次，其他请求等待该次提交结果。
6. Agent 停稳仍未提交的请求明确失败为 `group_decision_not_submitted`，不回退解析普通文本。

## 取舍与边界

- 不使用 `turn/end`：它是 Agent 生命周期边界，不是业务结果边界。
- 不使用 assistant 文本中的 JSON：文本没有工具级 schema、调用身份和原子性。
- 不由 Runtime 判断消息关系：`requestIds` 的组合完全由模型给出。
- 自动关联复核是已有判断的内部修订请求，独立提交；所有新群消息请求仍可由模型任意组合。
- 已提交 Decision 之后的新消息作为新请求处理；若它要求纠正既有动作，模型通过新 Decision 返回 task-context、task-reopen 或订正回复，而不是修改已发生的外部副作用。
- 本次仅迁移群消息 Decision；Task completion/checkpoint 等内部评审协议不在范围内。

## 验证要求

- 单 step 单请求提交。
- 同一 turn 多 step、多个无关请求分别提交。
- 多个相关请求合并提交且副作用只执行一次、来源证据完整。
- 连续 Steer 不覆盖已提交结果。
- 未知、重复、跨群 request ID 原子拒绝。
- 普通文本和 turn 最终文本不能完成 Decision。
- 未提交时明确失败且状态可恢复观察。
- 全量单元测试、打包、精确安装、本地 Runtime/Web 健康检查。
