# 目标与进展

目标：路由工具输出有界，Topic 决策只提供本次必要上下文，超长内容可固定请求续读，事项授权与独立反馈保持正确。

| 子目标 | 当前状态 | 证据 |
|---|---|---|
| A. 实现有界回执与增量上下文 | 已完成 | `topic-runtime.js`、`coordination-context.js` |
| B. 协议与回归 | 已完成 | `matrix.csv`、`round-1.md` |
| C. 本机切换和运行态核验 | 待执行 | 2026-09-21 本机还有 2 个 running Task、1 个 waiting Task；不重启 |

决策：保持 `unitId + unitRevision` 的原有 Host 校验；工具输出压缩不改变持久化 Schema。安装须在活动 Task 安全结束后，按 `docs/ops/resident-review-local-deployment.md` 执行。
