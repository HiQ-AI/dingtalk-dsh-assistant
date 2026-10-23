# R27 后端执行记录

职责：将插件 Claude 执行器由 headless stream-json 驱动改为 DSH `spawnTerminal` 交互式 Lead；保留 DSH 统筹、MCP 结构化提交、效果账、反馈复核及排空合同。配置页面与 DSH PTY 基础设施修复由其他执行者负责。本文件不代替总验收表。

## 实现

- 只接受持久绑定 `claudeSessionMode=interactive-team-v1`；旧无标记 headless 执行不能悄悄迁移。旧日志仍可读取及做已有 drain 证明回读。
- Claude >= 2.1.295；使用官方 HTTP hooks `onFailure:block`。终端输出仅用于精确工作目录信任提示，不解析模型文本作为完成。
- `PreToolUse` 绑定真实 call ID、输入、成员 ID，再进入原 Host 效果门禁；`PostToolUse`/失败事件结算。MCP 提交依旧要求真实已观测调用、结构化 schema 与 feedback receipt。
- Lead 通过 CLI 定义的 `dsh-worker` 创建具名 in-process 队友；人数由实际任务决定。禁止队友再派生、外部 peer 消息、后台命令、隔离 worktree 和权限模式升级。
- Agent 原生结果的 `agent_id`、`team_name`、`tmux_pane_id` 建立成员身份；不从配置 session UUID 拼 team 名。提交前回读真实 team 配置，必须仅剩 lead。
- 每成员职责及官方 hook 事件写入 `outputs/<executionId>/round-<inputVersion>-lease-<leaseEpoch>/<agentId>.md`，新轮不覆盖；进展接口返回成员文档索引。
- 保留原生 user 设置来源及认证，不搬运凭据。拒绝额外 user hooks 和 disableAllHooks，关闭本次 CLI 的已启用插件及 statusLine，检查 user 设置变更；固定 CLI hooks 和 in-process/Teams 控制设置。
- Stop 成功后通过两次间隔 Ctrl-D 正常退出。`SubprocessTerminalHandle.terminate()` 是整终端会话排空 Promise，不存在 pipe handle 的 waitForExit。取消和失败收尾共用同一 terminate Promise；失败仍释放 HTTP listener，但不写 drained、不释放执行身份。

## 已实跑证据与失败保留

1. `hook-probe.mjs` 真实交互探针：显式 CLI `dcf8562a-104a-4ec5-8ac3-e5f0080ba618`，原生队友 `ar27-worker-515ce33306896e77`，实际 team `session-70c158ac`。`hook-probe-events.jsonl` 证明 Lead/队友的 Pre/Post hooks 都带原显式 session_id，队友有独立 agent_id。Agent 结果为 `teammate_spawned` 且 in-process。此探针模型重复发 shutdown，最终期限终止退出 1；不计整队成功。
2. 首次主后端真实 MCP 算术运行 `d9275312-00eb-45c7-ae23-a81be18b107d`：MCP submit 与 PostToolUse 成功；发现 `--disable-slash-commands` 同时禁用 `/exit`，未自然退出，保留原日志。
3. 随后发现 PTY handle 没有 `waitForExit`，以及单次 Ctrl-D 不足以退出；修复后重跑，不覆盖原 execution 输出。
4. 最小完整链 `2cfc30da-8ee2-4c5a-b58e-e7adc8fc1ae7` / CLI `f327d8b3-8afb-4037-baa1-f393cd3e935e`：原生 UserPromptSubmit → PreToolUse → MCP execution_submit `{answer:15}` → PostToolUse → Stop → SessionEnd(reason=`prompt_input_exit`) → exitCode 0 → `drained.submitted=true` → Host onResult。证据为该 execution 的 `claude-events.jsonl` 与 `backend-minimal-readback.json`；早期共用 `backend-probe-result.json` 被较慢的旧调用覆盖，不能用它判定此轮，脚本已改为每个 execution 单独存 `probe-result.json`。实测 CLI 2.1.309（本机自动升级，不能沿用旧 2.1.308 版本描述）。

最小链仍使用旧已安装 DSH PTY provider，Node 宿主资源残留不计通过；统筹正在使用修复 provider 做两轮真实 Store + Agent Team 集成。测试执行者迁移原定向回归，包含反馈、旧身份、重复调用、效果未知、取消和无法排空负例。未在本文件声明最终产品验收、提交或部署完成。

## 集成暴露问题与修订

- live-1：Agent PostToolUse 持久化 await 期间队友 SubagentStart 已并发到达，原代码误报 member_unbound。改为只在已有 Host 准入 spawn 时等待最多 10 秒，必须由对应原生 Agent 结果注册确切 agent_id 才放行，未知成员和取消仍拒绝。
- 同时将反馈复核按 agent_id 分开：Lead 的 receipt 不能替队友证明已读。成员工具新增 Host feedback_read，后续效果调用必须晚于该成员自己的读取结果。
- PostToolUse 与 MCP 都必须对应 PreToolUse 明确 admitted 的调用；校验原生队友名称匹配请求、agent_id/name 不重复；首个真实 team 配置固化 native leadSessionId，后续不能替换。
- live-2（显式 CLI `74ccd3a5-6cf0-41bc-a01e-e349a01ce313`）：calc 多次向 `team-lead` 普通消息得到 native success/msg_id，但 Lead 原生 transcript 未出现 calc 的实际收件；check 向 `main` 的两次汇报分别成为 Lead 的 queued_command/peer 上下文。采用 CLI 原生 `to="main"` 作为本受管模式的普通 Lead 汇报地址，成员间仍用 name；门禁明确拒绝普通汇报写 `team-lead` 命名收件箱并指导正确地址，不做私有收件箱中继。原生 shutdown_response 继续遵循关闭协议。
- Windows 原生 PowerShell 纳入同一 Host 效果门禁，并和 Bash 一样拒绝后台回执；CLI --help 明确列出该内置工具，真实执行由统筹最终集成轮验证。
- live-2 后续另出现未知 SubagentStop，但旧 hook.error 没记录 ID，原生 transcript 也无对应身份；不能归因为某个确定内部代理。官方说明这两个生命周期事件还会覆盖内部辅助代理，而真实队友的 agent_type 实际是 calc/check 动态名称，不能凭文档猜用 dsh-worker matcher。最终不再订阅没有参与授权/关闭合同的 SubagentStart/Stop，保留 Agent Post、所有工具 Pre/Post、TeammateIdle、真实 team 配置和 PTY 排空。未知成员工具仍拒绝；race 用成员实际 PreToolUse 并发覆盖。
- 独立空闲探针 `a5ddda26-3035-45e6-b3cf-ec9d64fd8854` 未复现未知 SubagentStop，只有普通 Stop，之后 `/exit` 得到 SessionEnd；该事实只界定诊断盲点，不补造旧事件身份。
- 最终候选后端 SHA256：`FEF786BE61417BCAF2F6D42134BD5A30A80EFDD284649E3A5A26DA87FC0CC415`，已加入历史 start mode 防暗迁移及更完整错误身份诊断。最终回归/完整集成结果由总矩阵与后续轮记录给出。
