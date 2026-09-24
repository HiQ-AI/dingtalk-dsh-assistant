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

停机并核对当前实例及控制库状态后，对该草稿消息执行脚本 `--apply`，再启动新包。用户明确要求本次不备份。回读旧拒绝通知已封存、新运行产生澄清、实际渠道发送及引用回执。回读进展消息话题绑定、收信箱状态、话题详情与任务数。真实渠道送达必须有独立回读，不以通知准备或发送 ACK 代替。

## 第一轮本地切换后的发现

用户明确要求本次不备份。停机后的 v9 存储预检为 `ok=true`、`strippedFields=0`；草稿旧运行 1 条拒绝事实命令、1 条未尝试通知满足离线门禁，`--apply` 后原运行 `superseded`、旧通知 `superseded`，新运行版本 2。e095873 包 64 个源码/配置文件与源码逐一一致，PID 40872 监听 3080/18998。

新运行在 S 后进入 `MESSAGE_CONTEXT_OR_DISPATCH_FAILED:INVALID_JSON_VALUE`，未完成处理。只读重建 R 候选发现旧任务 `task-ceb5f5e3-dece-4be3-8186-06fb8e0d7934` 无 `title`，却有长目标；进入前八候选后 `executionDigest(card)` 不接受 `undefined`。此前测试候选均有标题，未覆盖该现场数据形状。现对旧候选标题用目标/任务 ID 补齐并添加长目标缺标题的回归；这是投影值域修复，不修改旧任务。新运行无业务命令，后续可由既有受控重处理入口再取当前代码处理。

46d3390 包切换后，本地 PID 31380 的 `/health=ok`、DWS healthy；对无业务命令的受阻版本调用受控重处理，版本 3 完成 R 历史补取并产生 `needs_clarification`：“收到。这个问题需要我继续排查，还是需要我实施修复并验证？”。旧拒绝通知保持 superseded。进展消息已绑定 `topic-review-issues-20260924` 且收信箱为 routed。澄清通知仍为 `prepared`，发送尝试 0。

进一步只读核查通知扫描发现：群职责新增日常代答署名后，4 条已送达旧通知的持久正文与按当前规则重新生成的正文不同；恢复扫描重复调用 prepare 时遇到 `MESSAGE_NOTIFICATION_CONFLICT`，在处理新待发通知前退出。修复为先按通知 ID 回读已持久记录，并只对首次准备的新通知应用当前职责。`node --test test/workflow-service.test.js test/message-ledger.test.js` 70/70，通过旧已送达正文保持不变、职责更新后新通知仍可发送的反例。真实渠道发送尚待下一次精确包切换后回读。
