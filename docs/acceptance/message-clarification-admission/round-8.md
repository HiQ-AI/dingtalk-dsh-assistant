# Round 8：四条交办链首次真实模型回放

使用现有 replay-native-coordinator.mjs、openai-codex / gpt-6-sol / low，读取当天四条原始消息，仅隔离 SQLite 与受控只读工具，无业务 dispatch、无钉钉发送。

- 同批 FAIL：四条落到 3 个话题（预期 1）。证据：round-8/native-topic-replay/topic-chain-batch.json 与 summary.json。batchCandidates 说明将创建 Task 错误引向 new/null 新话题，已据此修正通用共同锚点规则。
- 逐条 BLOCKED：其他代理编辑 message-topics.js 的短暂语法错误阻止 worker 加载，未进行此例模型推理；修复后另开新轮，未覆盖失败证据。
