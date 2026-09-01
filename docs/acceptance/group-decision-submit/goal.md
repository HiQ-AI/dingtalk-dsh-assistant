# Goal

将群消息 Decision 从 turn 末尾文本提取迁移为模型按 step 调用结构化工具提交，并证明多消息组合、一次性副作用和失败边界正确。

## Sub goal matrix

| Sub goal | 状态 | 证据 |
|---|---|---|
| SG1 协议与工具 schema | 已完成 | `round-1.md` |
| SG2 Runtime pending/提交/幂等 | 已完成 | `round-1.md` |
| SG3 模型提示词与假 LLM | 已完成 | `round-1.md` |
| SG4 多形态回归与全量验证 | 已完成 | `matrix.csv`、`round-1.md` |
| SG5 PR 与本地部署验证 | 未开始 | 待实现 |

## 重大决策

- Decision 是 Host 消费的结构化工具提交，不再从 assistant 文本提取。
- 模型拥有请求组合语义；Runtime 只拥有传输归属和一次性提交。
- 等待模型 Decision 不持有串行锁；不同 submission 按实际完成顺序继续。
- 只有修改 Task/Outbox 的短提交段按群串行，共享 Decision 仅由最早来源 owner 执行一次。
