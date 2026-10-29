# Round 12 — 静态合同审查与身份负例范围

日期：2026-10-29（Asia/Shanghai）

## 静态合同审查

- 不硬编码姓名/纠正关键词：`decision.js:42-43` 只接收 message ID 与稳定 at ID；`topic-runtime.js:315-322` 基于固定 messages 的 sender/sourceKind、目标 ID 和参与者 ID 校验，`:1039-1044` 使用该路由；`task-session-service.js:728-745` 按持久身份、版本和冻结字段对账。未发现姓名/关键词匹配触发发送逻辑。通用语义提示及配置 Agent 名称不等于硬编码业务身份规则。
- 不强制每次纠正单独发消息：`decision.js:39-46` 允许 `actions=[]` 的非空 reply，`:48-50` 保留独立 reason 分支；`topic-runtime.js:801` 仅对非空 reply 追加 outbox；`task-topic-coordinator.js:137` 明确可用 actions=[] 与 reply 适当沟通，也不要求每次纠正另发消息。此为源码合同审查，不证明真实模型行为。
- 引用身份与群边界：`test/topic-runtime.test.js:467-485` 的负例使用稳定 ID 门禁，同名展示不改变身份判断；引用他人或外群助手回复不授予本群 quotedReply 归属。只证明结构化 fixture 路径，不证明真实模型可消歧。先前误写为 `test/task-topic-routing-native.test.js`，现更正为该实际测试文件；历史结果不变。

## 证据边界与剩余项

- round-10/11 及当前恢复测试 `task-topic-routing-native.test.js:384-433` 的持久终态有界等待已被独立回读；taskIds 门禁修复与 resume 校验对齐，静态审查暂无剩余已证源码阻断。
- round-9 prepared 取消无堆栈、根因未证，作为历史失败保留；该旧观测不等于当前已证静态阻断。完整受影响 native 回归仍待 tests 原始回执，不因静态审查而推断通过。
- 未覆盖真实 LLM、正式库、真实钉钉外发或 sudden-crash 恢复。未创建最终 `report.md`。
