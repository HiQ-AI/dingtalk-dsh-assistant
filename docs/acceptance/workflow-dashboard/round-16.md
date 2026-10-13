# Round 16：运行链失败与独立审查

本轮归档合并前的失败链，不把已修复失败从 matrix 删除。具体命令、原始日志位置与修正见 [runtime-verification.md](runtime-verification.md)。

- 原生工程消费前五次未通过：正式工作区缺项、原文不含目标环境、嵌套 JSON 子串断言、已卸载会话读取、重启自动恢复旧 Run 的连接计数。前两次 raw 未保留，仅保留并明确标注 SQLite reconstructed summary；后三次 raw 留在 docs/tmp。
- v26 重发实际返回 `WORKFLOW_REISSUE_UNSAFE`：store reducer 仍要求 v22。保留失败后按来源版本修正，不放宽冻结查询范围。
- reset 独立审查发现另一条直接建 Run 入口未冻结配置，已补 controller 准入与完整 check。第一轮组合 11/12，真实 reset 查询通过，unit 夹具收尾因缺 `sessions.close` 失败；补齐夹具后另轮重跑。

上述记录不代表正式运行实例或外部数据库发生故障；所有执行使用隔离持久化、合成凭据与无网络 DB Client。
