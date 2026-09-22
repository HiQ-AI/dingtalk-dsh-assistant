# 已重开 Task 缺失原 Session 的定向恢复

## 现场与根因

2026-09-22 本地 v9 中三条 Task（翻译、合并提醒、单位不一致）均已通过真实 Topic 决策重开，state=queued、inputVersion=2、runSequence 分别为 2/10/7。旧 childSessionId 仍为 8 月原执行 Session；当前 DSH sessions 与备份内均无对应 session.jsonl。Runtime 的 queued+reopenContext 路径只调用 resumeLeaf，DSH 报 session not found 后每次 pump 均停在 task-start。Task 本轮目标、来源版本和历史结果仍在 Store，历史 Session 细节不可恢复。

## 实施边界

仅在 queued、存在 reopenContext、新执行轮次、当前 childSessionId 的 resume 明确报该 ID 不存在时新建独立 Session。任务 ID、inputVersion、runSequence、Topic 关联和已接纳操作不变；新 ID 落盘后继续现有 `[TASK_REOPEN]` 与 TASK_TOPIC_CONTEXT 路径。保留旧 ID 于 runHistory、记恢复告警与新旧身份；叶子重新核验当前来源与外部效果，不把旧结果当本轮证据。其它 I/O 错误、running/waiting、无 reopenContext 不自动换会话。

新 Session 创建成功但 Store 落盘失败时销毁新 handle并保留 queued 旧身份；Store 落盘成功后的重试按新 ID resume。原执行上下文缺失在告警与交接中显式可见。三个现有 Task 将按同一精确条件恢复，不人工修改存储 JSON 或补建重复 Task。

## 验证与部署

原生 Runtime 反例覆盖：重开且Session不存在恢复为同Task新Session一次；非缺失故障不换；非重开任务不换；恢复失败不提交错误身份；重启幂等。全量回归后按本地 runbook 预检、备份、安装精确包并核验三个 taskId 均进入 running 或明确的当前轮等待态、旧操作无重复、Web/入站/其它活动 Task 保持。
