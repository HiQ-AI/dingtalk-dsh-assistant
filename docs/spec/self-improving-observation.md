# Self-improving 结构化观测

## 目标

为 DSH Task 叶子会话补充 `use-self-improving` 的结构化观测，能够区分技能触发、索引查询、主题读取、采用、现场复核与最终效果。目录曝光、系统提示或普通助手文本不得计为触发；工具成功也不得自动计为有效。

## 方案

- Runtime 向 Task 叶子注册 `submit_self_improving_observation`，由 Agent 在实际使用 `use-self-improving` 后按阶段提交。
- 观测使用独立 storage table，以 `taskId + observationId` 聚合，不受普通活动 500 条上限影响。
- 只持久化白名单元数据：1–4 个短查询词、逻辑 scope、命中条目 ID、主题读取状态、采用动作引用、验证状态与证据引用；不保存自由文本查询、提示词、文件路径、主题正文、工具原始结果、凭据或消息正文。
- `positive` 只有在 `live-verify=passed` 且 evidence level 为 `live-verified` 时接受；其他情况必须保持 `unknown/neutral/negative` 的真实边界。
- HTTP 通过 Task ID 只读查询；Observer 在任务卡中按需读取摘要，旧 Task 显示“未观测”。

## 验证

- Store：阶段合并、幂等、跨 Task 隔离、非法跃迁、正向证据门禁、持久化恢复。
- Runtime：仅正确 Task 叶子可提交，版本绑定正确，目录/文本提及不产生记录。
- HTTP：按 Task 过滤，只返回脱敏白名单字段。
- Observer：不加入全局轮询，任务卡可按需展示观测摘要。
- 完整执行 `npm test`，并检查构建后的 Web client 与仓库状态。
