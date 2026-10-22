# SG7 Claude Code CLI 执行适配记录

- 负责：`collaboration_eval`；统筹：`root`；独立验收：`progress_audit`。
- 目标：默认 DSH，新增执行可选择 Claude Code CLI，续办固定后端与原会话；保留身份门禁、操作账、反馈输入准入、执行文档及排空要求。
- 当前阶段：独立适配器实现及离线验证已完成；最终源码 SHA256 `1cb9e0123657080f99b73732115b666072bedb34c9b5b9c08d73589d9ff82a77`。用户明确稍后登录，本轮没有真实账号模型调用、读取凭据或业务任务操作。

## 结论与最小合同

选择 **CLI 原生工具 + 强制 ask + permission MCP 前置门禁**。`claude-execution-session.js` 独立实现原执行会话接口，使用现有 Host subprocess 的受管进程范围，不复活旧 runner。MCP 只桥接权限、提交、进度、资源与团队协作；工具仍由 CLI 原生执行。配置仅 `executionBackend`，固定调用 PATH 的 `claude`，使用 CLI 自身模型与登录状态，不把 DSH provider/model 传给 Claude。

候选对照：仅解析 stdout 无法在效果发生前检查租约，排除；仅用 hooks 在本机版本不能可靠失败关闭，排除；全部工具转发 DSH MCP 可控制效果，但改变原生工具体验，留作未采用候选。当前方案通过 MCP 权限响应前调用原 `onNativeExecution(started)`，结果回流后调用 settled；缺失结果保留 unknown，不把 CLI result success 当业务完成。

新增模块的理由：原 `execution-session.js` 深度依赖 DSH 会话、消息、工具与原生日志，CLI 协议与进程生命周期不应混入该实现。

## 本机与官方合同

- 本机 `claude --version` 为 2.1.212。`--permission-prompt-tool` 隐藏于帮助，但实际安装包的参数定义存在；本机原生进程已成功使用。`manual` 是 `default` 的显示别名，实际 `--permission-mode default` 可运行。[CLI reference](https://code.claude.com/docs/en/cli-reference)
- 官方规则顺序为 deny、ask、allow；ask 可覆盖 allow。sandbox 自动允许 Bash 是反例，因此启动显式关闭 `autoAllowBashIfSandboxed`，精确工具名单、禁子代理、禁用户和项目 settings、自定义 hooks、额外 MCP。仅明确 allow 本 Host 的控制 MCP，permission 本身不在模型 allow 名单内。[Permissions](https://code.claude.com/docs/en/permissions)
- Host 固定传 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`，官方说明覆盖显式后台、自动后台和 Ctrl+B；本机 2.1.212 的实际模型工具 schema 已不含 `run_in_background`。permission 仍拒显式后台，若原生 Bash 回执意外带 `backgroundTaskId`，不结算成功，终止受管范围并把缺失终态的效果保留 unknown。[Environment variables](https://code.claude.com/docs/en/env-vars)
- 本机不支持依赖新版 hook `onFailure:block` 的保证（该行为要求 2.1.295+），因此 hooks 不承担权限或操作账门禁。[Hooks](https://code.claude.com/docs/en/hooks)
- 使用 `--session-id` / `--resume` 指定原 UUID，不用最近会话 `--continue`；流式 user echo 只证明输入准入，不能声称模型已理解。由 Host 记录 ACK 后回调反馈收据，提交前仍检查新反馈。[Programmatic CLI](https://code.claude.com/docs/en/headless)
- HTTP MCP 是 CLI 官方支持的连接方式。服务只绑定回环随机端口、每运行随机令牌、固定绑定身份；模型不能提供或替换 task/lease。令牌不写日志或本验收产物。[MCP](https://code.claude.com/docs/en/mcp)

## 已执行的原生离线门禁探针

探针用本机真实 2.1.212，模型 HTTP 仅回环合成响应，认证为无效合成值，独立临时配置目录。只让模型提出两次固定文件 Write；permission MCP 为实际 CLI 调用。原始结果留 `docs/tmp/claude-native-contract-probe/`，不是生产业务验收。

| 场景 | 实际回读 | 结论 |
| --- | --- | --- |
| allow 与 ask 同时匹配 | 3 次合成模型请求、2 次 permission 调用；文件最终 `synthetic-2` | 每次写均经过门禁，ask 未被 allow 绕过 |
| deny | 2 次 permission；目标文件不存在；CLI exit 0 | 拒绝有效；exit 0 不等于工作成功 |
| invalid | 权限响应结构不合法；目标文件不存在 | 失败关闭 |
| disconnect | 权限服务连接中断；目标文件不存在 | 失败关闭 |

上述四例只覆盖 Write 权限路径，不能升级为全合同通过；适配器与生命周期的后续证据如下，原始首轮记录保留。

## 最终真实 CLI 两轮离线验证

跨轮脚本为 [`scripts/verify-claude-adapter.mjs`](../scripts/verify-claude-adapter.mjs)，先执行 `--check` 零副作用检查，再传一个新的 `docs/tmp` 子目录运行。脚本调用真实 CLI、真实锁定 Host subprocess 和生产 Store，使用隔离 CLI 配置及回环固定 Anthropic 协议响应。没有真实账户或模型请求。

最终产物摘要见 [`cli-adapter-results.json`](cli-adapter-results.json)，原始材料留 `docs/tmp/claude-adapter-native-round-7-final/`。原适配器摘要缺陷记录在 `docs/tmp/claude-adapter-native-round-7-first/`：第二轮没有 `--session-id` 时误取 argv[0]，真实 `--resume` 和 journal 正确。没有改写该首轮材料；脚本已修缺参为 null，新目录复验 PASS。

| 最终场景 | 实际证据 | 结论 |
| --- | --- | --- |
| 首轮 Write → Read → progress → team → submit | journal seq 9/12 写前准入及返回，14/17 独立读取，19/22 阶段与团队回执，25 提交，32 排空 | PASS；6 次合成模型请求 |
| 第二轮原身份续办 | 同 executionId 和 provider UUID；显式 resume，seq 33/38 开始和绑定，41/44 读取，52 提交，59 排空 | PASS；5 次合成模型请求 |
| 生产账及文件独立回读 | SQLite 当前 v2 succeeded/drained，v1 completed 保留，仅一个 operation succeeded；实际文件精确 `synthetic-cli-adapter\n` | PASS；两份轮次 MD 实际存在，字节和摘要见 JSON |
| 后台关闭配置 | 两次真实 launch 都收到固定 env；11 次模型请求的 Bash schema 均没有 `run_in_background` | PASS；未执行 Bash 超时提升测试 |

脚本记录耗时 6.325 秒。独立审阅者 `progress_audit` 已读真实 journal、模型请求、目标文件及 SQLite，结论与上述一致。真实 Write 的前置回调检查目标文件尚不存在，再调用生产 operation.prepare/start；只有权限回执后 CLI 才实际写入。`exit 0`、自然语言答复和 MCP 收到提交均不能单独触发完成。

## 独立生命周期反例及修复

[`acceptance-execution.md`](acceptance-execution.md) 与 `cli-native-independent-4.log` 记录最终 **26/26 PASS、0 skip、14.60 秒**；运行前后适配器 SHA 与真实 CLI 最终两轮一致。该层使用真实 Host subprocess/Windows Job、固定 Node 协议子进程、实际管道/HTTP MCP/文件及父孙进程，不能当作真实 Claude 推理验证。

保留的首错包括：

- `cli-native-independent-2.log`：14/15 PASS，真实写回后立即 submit 因 stdout 与 HTTP 两通道顺序竞争被误拒。修复使用 `claudecode/toolUseId` 关联 MCP 请求与串行 stdout 的相应 tool_use，确保前序结果结算已处理，不依赖 sleep。
- `cli-native-boundaries-1.log`：4 个断言通过但测试进程未退出，不能记 PASS。`waitForExit=false` 跳过了权限桥关闭；现先停止接纳、关闭桥、等待在途回调，再检查排空。无法证明进程排空时仍保留执行占位和错误。

最终用例覆盖旧身份/拒绝准入零写入、原 UUID 恢复与未创建会话重试、缺提交/坏 JSON、缺工具结果保留 unknown、取消实际父孙进程、启动中取消、在途回调结束后才排空、日志 hardlink/junction 拒绝、无法证明排空不接纳结果、异常后台句柄保留 unknown。反馈 ACK 仅表示输入准入；当前消息集合的随机读取凭据与对应工具结果序号共同阻止旧提交、旧预生成工具借后到反馈越过门禁。

## 接口及持久证据

- 导出 `createClaudeExecutionSessions({ ctx, isCurrent, getWorkspaceDir })`、`claudeExecutionLogPath(workspaceDir, executionId)`。
- 返回 `run/cancel/feedback/assertDrained/recoverDrained/close/readProgress/readOperationContext`。run 保留当前 service 回调结构；`onSessionBound` 仅落账，不注册 DSH 会话。
- 日志路径：任务工作区 `outputs/<executionId>/claude-events.jsonl`；记录 provider、固定 logical/provider session、inputVersion/digest/lease、输入 ACK、前置 gate、工具结果、提交候选、CLI 终态和受管范围排空。
- 未有可信排空记录的历史运行不自动 resume，不重放 unknown。只有可信 `session.bound` 才使用 resume；启动失败且从未 init 的执行仍用原 UUID 的 session-id。`assertDrained` 不以内存 Map 缺失推断历史排空。CLI 错误不伪装成 DSH provider terminal 或触发 DSH 自动重试。
- 原逻辑 sessionId 保留 `task-execution-<uuid>`，CLI 仅取并严格校验 UUID。CLI raw 日志与 DSH JSONL 分开读取，DTO/UI 由统筹按后端处理。

## 交付边界与后续检查点

精确工具名单及关闭自定义 settings/hooks 会限制 CLI 插件与动态 Skill 工具入口；工作区说明文件仍可能进入 CLI 上下文。这是受管执行合同，不宣称等同任意交互式终端全部定制能力。权限机制不是 OS 沙箱，授权范围仍由当前任务及 Host 门禁约束。

真实账号模型 run/resume 留待用户登录后执行。当前真实 CLI 层未覆盖多成员 peer/readResources 往返、新反馈跨真实模型请求的全部顺序、Bash 实际命令或前台超时、所有工具/平台/CLI 版本。两份 MD 已实际回读，但本探针未在切轮前冻结旧轮 SHA，不能据现存两份文件反推全过程不变。后台固定开关不等于 OS 沙箱，也不能证明外部或远程工作已消失。原始 CLI transcript、SQLite 和完整模型协议不提交；包构建、部署和真实业务由统筹另行记录，不能由本文件的离线 PASS 替代。
