# 第一轮：只读故障取证

2026-09-30，未修复业务代码、未修改运行控制库或原消息、未发送群消息、未重放、未部署。

## 实跑探针

```powershell
node docs/acceptance/message-processing-20260930/scripts/read-only-audit.mjs D:/dsh_home/workflows/runtime-v2/control.sqlite D:/dsh_home/profiles/web/node_modules/@zzusp/dingtalk-dsh-assistant docs/acceptance/message-processing-20260930/round-1-evidence.json
```

退出码 0，assertions=passed，messageCount=7，pendingRouting=[113,114,115]，taskCountToday=0，installedMatchesMain=true。

这里的 passed 表示确认了故障复现，不表示修复验收通过。原库仅用 SQLite readOnly；通知函数的 store.command 为内存数组，没有调用 DWS 发送。输出文件使用 wx 防止覆盖本轮证据；复查时请提供新的输出文件名。

- S 请求容量精确复现：#114 8372/8000，#115 8273/8000；均未领取任何模型节点。
- #113 的候选目录资源不在模型输入合法资源中，却通过当前 schema/资源校验；pending 未解除。
- #111 8 次 R，0 次 I/IB；当前通用 topic 始建于 9 月 24 日，标题仍为旧审核草稿问题。
- 时间类型比较复现：17:49 文件已进入 17:15 原始快照；统一时区时间戳比较能够识别其为后续输入。
- #112 no_action 与群职责被 @ 必须回复冲突；S 输入未包含该回复规则。
- 通知探针：needs_context=0，needs_attention=0，needs_clarification=1；accepted create + replyPolicy=none 时准备通知数和 Owner 报告查询数均为 0。
- 真实函数准入探针：#111/#114/#115 的当前原文均未被 isDirectedTaskRequest 识别。

## 独立运行与通道回读

`Get-NetTCPConnection -State Listen -LocalPort 3080,18998`：两端口 OwningProcess=40192。`GET http://127.0.0.1:18998/health`：status=ok，recoveryIssueCount=0，inboundProcessing=true，两群 listener=ready/backfill=ok。

使用运行 profile 的 `dws chat +chat-messages`，本群时间范围 `[2026-09-30T00:00:00+08:00,2026-10-01T00:00:00+08:00)`，asc/page-all/page-limit=10/max-items=500/no-reactions：

```json
{"count":7,"complete":true,"hasMore":false,"failedCount":0,"failures":[],"pagesFetched":1,"partial":false,"truncated":false,"stopReason":"source_complete","senderFilter":{"applied":false,"requested":false,"status":"not_requested"}}
```

七条 ID 与现场一一对应；DWS 为两份 Excel 返回可读取 fileId 资源，当前控制库 attachments 均为空。没有发出、撤回、编辑任何消息。未保存完整群聊导出或 Excel 内容。

修复设计、未证实边界及待执行的 A01—A14 验收用例见 `docs/spec/message-processing-repair-20260930.md`。本轮不生成“全绿修复 report.md”。
