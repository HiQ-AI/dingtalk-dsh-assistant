# Backend Contract

本轮实现基线为 `ca7a3fd`，仅改后端观察读模型与测试，不改持久状态机。

## DTO

- `work.relations` 与详情顶层 `relations`：每个目标 member 一条关系。`relation.state === relation.dispatch.status`，值为 `waiting|pending|dispatched|failed|cancelled|paused|stale|blocked|unknown`。
- `relation.condition` 固定为 `all`；现有持久依赖是 `member.dependencies.filter(!fulfilled)`，没有 any-of 合同。
- `target` 与每个 `prerequisites` 提供 `taskId/title/taskHref`；前置从完整同 coordination 成员集合解析，不受 work entity 分组、分页或详情截断影响。
- `dispatch` 始终提供 `status/reason/nextStep/occurrenceId/jobId/commandId/receipt`；`reason` 为安全字符串或 null，`nextStep` 恒为字符串，`receipt` 为 `accepted|replayed|absent`。
- `taskDetail` 增加 `coordination: { condition: 'all', relations }`，复用已有 `/state/tasks/:id/detail` 接线。

## 证据规则

- A 正式前置只认当前 `completionReceipt`、版本匹配的 `completionProof` 与正式 Task 完成证明；B 的 execution/status/completion 不推导 B 调度成功。
- B 调度成功只认以冻结 `member.command.id` 查询到的 receipt，且 receipt result taskId 与 member taskId、member effectiveVersion 全匹配；同任务其他 command、occurrence 内不匹配 instruction/command 的嵌入 receipt 均不算。
- 关系 occurrence 严格限定当前 work entity；成功还需当前 occurrence result 的 instructionId/commandId 同时匹配（direct apply 无 occurrence 时只查精确命令回执），不得借其他 trigger 的失败、取消或成功。
- taskCoordination 同一关系去重按 occurrence 接纳时间选择最新实际安排；同刻优先本实例已记录的精确命令接纳，最后以 occurrence ID 稳定排序，不用含 B 更新时间的 work.updatedAt 决定。纯查询及官方命令均覆盖旧取消、新成功、B 后续更新的反例；ID 字典序与输入数组反转均不改变结果。最新实际安排若为取消，任务详情选择该取消安排（absent），旧成功 work 的精确命令接纳仍保留，不视为撤销。
- waiting_trigger 显示 blocked + 等待触发条件；trigger_paused/cancelled/superseded 分别为 paused/cancelled/stale，不冒充已可下发。
- 无 receipt 为 pending/unknown，取消/暂停/版本变化/实际持久阻塞按对应状态；不制造回滚失败 receipt。已记录的精确命令接纳不会因后续 B 执行或 A 新版本覆盖。
- 取消计划/occurrence 且 notification.start 尚未取得 permit/attempt 时，提醒台账结果为 cancelled，不是 query succeeded 或 delivery failed。
- work ID 后缀按底层非空 opaque text 合同接受并通过 `encodeURIComponent` 传输；详情不再错误拒绝 slash、空格、反斜杠或长合法 ID；store text 合同也接受嵌入控制字符，NUL 的官方命令持久化与编码 HTTP 往返已实证 200，不新增相矛盾的拒绝规则。

## 实施与验证

- 实施文件：`packages/dingtalk-dsh-assistant/coordination-observer.js`、`packages/dingtalk-dsh-assistant/task-session-service.js`、`test/coordination-observer.test.js`。
- 已覆盖真实 SQLite/HTTP：多前置 AND waiting→pending→dispatch、跨 trigger/coordination A→B→C、同任务异 command receipt 反例、stale 无 receipt、B 完成不改变 dispatch、取消前 start、合法 ID、任务详情只读与聚合截断。
- 当前定向套件已通过：observer 66 项，连同 task-session HTTP、ledger、execution-proof、trigger、observed-prerequisites 共 118 项；未部署、未提交。
- 追加官方命令关系断言：task.wait blocked、task.control pause/cancel、instruction pause/cancel 后保留proof但不能释放B、重复occurrence accept/command幂等。真实stale occurrence command拒绝会事务回滚，无持久failed receipt，DTO因此显示stale/absent；当前没有能官方命令持久化通用failed action的入口，failed投影仅用纯查询夹具覆盖，不能声称真实失败持久链已验证。
- `CLAUDE_EFFORT` 当前会话实读为 `high`；用户要求 low，但无法证明实际 low，未修改配置或环境。
