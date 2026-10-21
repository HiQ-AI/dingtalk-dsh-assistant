# 任务统筹决定历史

`GET /state/tasks/:taskId/decisions` 沿现有受保护的 `/state` 读取入口，返回该任务历次已接纳决定，按新到旧排列。查询不会唤醒或续办任务。

| 查询参数 | 约束 |
|---|---|
| `limit` | 默认 20，整数 1–100 |
| `before` | 可省略；继续分页时传上一页 `nextBefore`，必须为正安全整数 |

```json
{
  "taskId": "task-id",
  "decisions": [{
    "id": "original-command-id",
    "sequence": 123,
    "taskId": "task-id",
    "sessionId": "owner-session-id",
    "leaseEpoch": 3,
    "requirementRevision": 1,
    "controlRevision": 1,
    "contextRevision": 0,
    "recordedAt": "2026-10-21T00:00:00.000Z",
    "triggers": [{"wakeId": "wake-id", "kind": "execution.progress.review", "executionId": "original-execution", "inputVersion": 2, "leaseEpoch": 2, "lastSequence": 42}],
    "decision": {"action": "wait", "summary": "首次发现范围偏离，已反馈原执行，下一次核对目标产物。", "evidence": ["原记录第42条"], "limitations": ["反馈进入模型步骤尚不证明已落实"]}
  }],
  "nextBefore": 123
}
```

`nextBefore=null` 表示没有更早记录。游标基于不可覆盖的命令收据序号，新决定插入不会移动旧页边界。不存在任务返回 404，非法页长/游标返回 400。`sequence` 是存储游标，不是模型日志序号；执行日志定位使用 `triggers.lastSequence`。

完整 `decision` 保留 summary/evidence/limitations 和实际存在的 question/audience/attemptedActions 等字段。wait、人工介入、完成、任务对话回复均与原状态变更在同一事务存储；失败提交不伪造已接纳决定，原调用和失败仍在统筹日志中。同命令重试不新增历史。

统筹使用 `task_decisions_read({limit,before})` 读取同一接口数据，Host 将任务固定为当前受信 binding，不接收模型提供的其他 taskId。历史不自动注入每轮上下文；`lastDecision` 仍用于最新进展。

上线前的决定保留在原命令收据和原统筹日志；没有 `taskDecision` 结构的旧收据不从旁支快照猜测补录，空列表不代表旧任务没有历史。新增部分索引只提高读取效率，不删除或迁移旧收据。回退旧版代码不会删除这些历史，但旧版后续新决定不具备此查询结构。
