# 群消息快速取消叶子任务

## 问题

群消息被误判为需要执行并创建叶子任务后，后续“无需处理、停止、忽略刚才”等明确撤销消息没有对应的结构化 Decision 动作，只能作为 `task-context` 继续发送给叶子。现有 Web 取消路径又在全局 Task 串行队列中等待，并同步等待 `handle.dispose()` 完成，导致中断信号和可见状态都可能延迟。

## 目标

- 群聊明确撤销正在执行或排队的同一任务时，Resident 返回 `task-cancel`，不得继续追加上下文。
- Runtime 在等待 Task 串行队列前同步调用 DSH `agent.cancel()`，立即中止当前叶子 Turn 并清空待执行输入。
- 取消请求建立后拒绝叶子的迟到 checkpoint/result；任务持久化为已取消并归档，同时保留撤销消息的来源记录。
- `handle.dispose()` 在取消状态落盘后异步收敛，不阻塞群消息 Decision 或 Web 取消响应；Runtime 关闭时仍等待尚未完成的 dispose。

## 约束

- `task-cancel` 只能指向本群尚未完成的 Task，且 `sourceMessageIds` 必须包含当前判断中的撤销消息。
- 取消是显式撤销执行授权，不从模糊讨论或普通目标收窄中推断。
- 不改变 Task 状态枚举和 storage schema；继续使用 `completed + 已取消：... + archivedAt` 表达取消结果。

## 验证

- Decision schema 接受 `task-cancel` 并拒绝缺失目标、原因或来源的结构。
- 并发测试让叶子 `dispose()` 长时间未完成，断言群 Decision 仍能先完成、`agent.cancel()` 已同步调用、任务已归档，迟到结果被拒绝。
- Web `cancelTask()` 同样先发取消信号，不等待 dispose。
- 全量 `pnpm test` 与三包 `pnpm pack` 通过。
