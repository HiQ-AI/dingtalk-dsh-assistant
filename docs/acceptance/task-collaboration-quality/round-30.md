# R30 真实双轮团队与 PTY 验收

本轮使用 v2 双包干净 pnpm 消费者；最终 backend SHA fef786be61417bcaf2f6d42134bd5a30a80efdd284649e3a5a26da87fc0cc415。

- 第一轮真实交互 Lead 创建 calc/check 两名原生队友，分别计算及交叉核验 37×19=703；每名成员的 SendMessage 与 Lead 实际 peer attachment 均被脚本核对。两人关闭后提交，真实 exitCode=0，drained=true。
- 第二轮以同一 UUID resume，读取第一轮文档，不再创建队友。首次误用 hostname.exe 被前置门禁拒绝；随后精确 PowerShell 探针输出 DSH_CLAUDE_PTY_OK，唯一 operation 经 prepare/start/settle 后 succeeded。提交后真实 exitCode=0。
- 脚本逐字节比较第一轮主文档及两名队员文档 SHA，第二轮未覆盖；wrapper 自然退出0，独立 Get-Process 回读41860、86204、35408均不存在。
- v2 PTY 真实0/7退出顺序、Claude无模型CLI、静默退出/取消/dispose均通过，见 round-30/pty-execution.md。部署提案合同3项通过，见 round-30/config-execution.md。

证据：round-30/live-team-proof.json。原始隔离账本与日志保留 docs/tmp/interactive-team-live-4，不纳入Git，避免复制原生会话上下文。此轮不声称现场钉钉业务验收，也尚未部署。
