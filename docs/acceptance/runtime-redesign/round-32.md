# 静默进展话题与旧排查新反馈（第 32 轮）

日期：2026-09-24。

## 现场基线

- 进展消息 `msgQg6tln8bTRD2WlpG73Lwgw==` 的运行以 `message_quiet` 结算，收信箱却是 `routed` 且 `topicRefs=[]`。引用的已送达更正消息能经旧 Outbox 来源定位唯一话题 `topic-review-issues-20260924`；本地任务表未找到消息中的外部任务 ID。
- 草稿问题消息 `msglrqv1gZoH6YJAWCMyjda8w==` 已匹配到已完成的纯排查旧任务。I 节点产出 `fact`，旧任务只读门禁将命令拒绝，运行结算而没有澄清或任务。对应拒绝通知在控制库中仍为 `prepared`、`leaseEpoch=0`。

## 本轮验证

- `node --test test/message-ledger.test.js test/workflow-service.test.js test/workflow-entry.test.js test/http.test.js`：88 项通过，0 项失败。覆盖唯一话题回填、未匹配待归类、无模型/任务副作用、旧排查澄清、肯定答复的新任务准入、过期拒绝通知封存及已尝试发送时拒绝重处理。
- `pnpm test`：893 项通过，0 项失败、0 项跳过。
- `node scripts/build-web-client.mjs`：退出码 0，未产生 Web 源码差异。
- 历史草稿消息离线脚本 `--check`：`valid=true`、拒绝事实命令 1 条、未发送拒绝通知 1 条、已尝试通知 0 条；预定新运行 ID `msg-replay-ba1e3a6543d09321df5f2db9cbeeca324753da45`。尚未执行 `--apply`。

## 部署后待核

停止并备份当前实例后，对该草稿消息执行脚本 `--apply`，再启动新包。回读旧拒绝通知已封存、新运行产生澄清、实际渠道发送及引用回执。回读进展消息话题绑定、收信箱状态、话题详情与任务数。真实渠道送达必须有独立回读，不以通知准备或发送 ACK 代替。
