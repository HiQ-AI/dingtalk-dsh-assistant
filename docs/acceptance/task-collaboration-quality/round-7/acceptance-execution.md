# SG7 独立生命周期与验收执行记录

- 负责会话：`progress_audit`；统筹：`root`；CLI 方案：`collaboration_eval`。
- 当前阶段：审查完成，等待双后端接口方案定稿后补独立集成用例。用户已明确 Claude Code 后续再登录，本轮以代码与离线验证交付，真实模型未验证单独列明，不作为本轮等待条件。
- 本轮目标：验证默认 DSH、执行创建时固定后端；Claude CLI 接入不降低身份、效果账、反馈、资源排空、恢复和每轮执行文档合同。
- 范围：只读源码审查、官方协议和本机 CLI 只读检查；本文件之外暂未修改生产实现。没有登录、读取凭据、模型调用或现场任务操作。

## 当前结论与本机证据

后端可选择有实现基础，但不能仅把 `executionSessions.run()` 换成 `spawn('claude')`。现有恢复、效果核对、进度读取与 UI 导航直接依赖 DSH 会话协议；适配器必须明确负责对应证据，不能用 CLI 退出或不存在 DSH 句柄推断已排空。

本机 `C:\Users\64554\.local\bin\claude.exe` 为 **2.1.212**，`--version`、`--help` 退出码 0；`auth status` 退出码 **1**，`loggedIn=false`、`authMethod=none`。证据为 `claude-cli-readonly-check.json`，帮助全文 `claude-cli-help.txt`。文件已独立读回；帮助 SHA256 为 `067B1754601C99196D8C9E91F99914434341EE807AA2CE50DD6C898F231D5F4D`。安装可调用不等于真实模型执行/续办通过，真实模型验收目前缺已登录环境。

## 不能直接替换的生产边界

| 边界 | 当前证据 | 接入要求与反例 |
| --- | --- | --- |
| 后端与稳定身份 | `dynamic-task-store.js:129`、`:879`、`:939` | 创建时保存后端，并在 binding/read DTO 中可核对；配置改变仅影响新执行。输入续办、provider retry 不改变后端、executionId 与 provider session。现 DSH sessionId 为 `task-execution-<uuid>`，不能直接作为 CLI `--session-id` 的 UUID。禁止共享 cwd 下使用 `--continue` 选择最近会话。 |
| 先记效果账再执行 | `execution-session.js:373`、`:401`、`:410`；`task-session-service.js:693` | Host 在真工具调用前执行 operation.prepare/start，并验证当前租约。只消费 CLI stdout tool_use 是事后观察，无法保证旧租约在撤销后不执行。必须有真正派发前的 Host 工具门禁；工具输出或进程退出后才补账不合格。 |
| 取消与排空 | `execution-session.js:285`、`:838`、`:850`；`dynamic-task-store.js:180` | 取消等待当前模型、后台 job、subprocess 句柄和持久日志排空；失败保留占位及资源锁。`child.kill()` 成功、stdout EOF、CLI result 或父进程退出均不能证明子孙已退出。 |
| 重启恢复 | `task-session-service.js:1094`、`:1103`；`execution-session.js:860` | 当前原生恢复校验 DSH 历史身份及未配对 tool calls。CLI 必须核验自己的持久进程/会话身份与终态；Host 重启导致内存 Map 为空不能当作无存活进程。写入后崩溃必须保留 unknown，不自动重放。 |
| provider 重试 | `task-session-service.js:228`、`dynamic-task-store.js:1089`、`execution-provider-failure.js:1` | 现逻辑核对 DSH turn/end 序号、错误摘要及 input/lease。CLI 不得伪造 DSH terminal；需明确后端终态证据和可验证分类。未登录/权限/配置错误不能当作暂态网络异常反复重启；原预算不随 inputVersion 重置。 |
| 反馈真实消费 | `execution-session.js:678`、`:694`；`dynamic-task-store.js:1077` | 原合同以落盘 user/message 与 step/start 证明准入；stdin write 成功或 echo ACK 只证明传输接收。CLI 需真正模型步骤的消费证据，保留 received/consumed 区分及最终提交与新反馈竞争门禁。 |
| 进度及操作原始材料 | `dynamic-operation-readback.js:19`、`:123`、`:157`；`task-session-service.js:1157` | 当前全部按 DSH JSONL identity/input/工具事件读取。应按固定后端读取真实原始材料；MD 仍从权威 Store 生成，不能把 CLI 任意文本当已验证结果。 |
| 会话持久化/跳转 | `task-session-persistence.js:24`、`:175`；`task-session-service.js:308`、`:354`、`:1142`；`web-client.js:581`、`:1582`、`:1768` | `.dsh/sessions` 路由与 `ctx.uiWorkspace.openSession` 是 DSH 协议，CLI UUID 不应注册为 DSH 原生日志。CLI 应明确日志/文档入口及后端标识；不能展示可点击但必失败的 DSH 跳转。 |
| 旧轮冻结 | `session-workspaces.js:104`、service 的 continue/retry prefreeze | 新轮前先物化旧账的最终快照；同 inputVersion 允许运行到 drained 刷新，新 inputVersion 不能用新结果覆盖旧 MD。后端切换配置不改变旧文档来源。 |

## 现有能力可复用程度

1. `dynamic-process-scope.js:7` 可复用 Host subprocess 的所有权语义：以实际工具异步上下文登记句柄，terminate 后 waitForExit。它只观察 Host 的公开 subprocess 服务，无法自动托管 Claude 内部 Bash 启动的子孙。
2. `execution-local-acceptance.js:84` 的纯 `acceptanceProcessTree` / `acceptanceProcessesAlive` 证明仓库已有 PID+出生时间+父进程关闭窗口的判定经验；其历史 runner 不在当前发行闭包，不建议为 CLI 整包复活。应使用当前 Host 的公开进程能力，缺能力则明确失败，不遍历/结束所有 claude.exe。
3. `dws-runner.js:19` 的 shell-free spawn、隐藏窗口和逐行输出处理可借鉴，但其 `child.kill` 与 exit 回执不能满足 CLI 子树排空/重启恢复合同，不可直接当安全执行器。
4. Store 已有 operation、feedback、资源互斥、阶段报告、输入版本及幂等收据，全部继续复用。CLI MCP 桥仅把已绑定的 Host 回调带到模型，不新增另一套任务状态或让模型提供租约/授权身份。
5. 进一步读取锁定 native profile 实际安装的 `@deepseek-ai/dsh-subprocess-local@0.2.1-alpha.2`：`lib/index.js:1356` 的公开 spawn 已按平台选择 Windows Job owner（`:1394`），`done` 与 `waitForExit` 分别记录直接命令退出和整个受管范围停稳。应直接复用 `ctx.subprocess`，不重复实现进程树。探测失败时源码 `:1403` 明确警告 fallback 较弱，不能假定所有环境均获得 Job containment；真实组合测试应包含孙进程退出验证。该公开服务会清洗 ambient 凭据与 `DSH_*`，再合并显式 env；不得用完整 `process.env` 覆盖回去，CLI 认证形态是否依赖被清洗的变量需明确区分。本机检查没有读取这些变量值。

## 三种候选与排除理由

- **只封装 CLI print/stdout**：改动小，但没有派发前效果账门禁、可靠消费和子进程证明；排除。
- **CLI 原生工具配 PreToolUse/PostToolUse 桥**：保留工具生态，但必须在 2.1.212 实证 fail-closed、取消中工具返回、hook 丢失/崩溃及外部副作用；目前证据不足，不作为已完成方案。
- **CLI 负责模型会话，工具经受信 Host MCP 桥**：最有利于复用已存在的 current/operation/反馈/资源合同；仍需证明 CLI 自带工具和额外 MCP/子代理不可绕过、进程与 session 日志真实持久。建议作为优先评估路径，由统筹与 CLI 代理定稿；不是把 MCP ACK 当业务完成。

## 官方协议核对与版本限制

- 本机帮助确认支持 `-p`、`--input-format stream-json`、`--output-format stream-json`、`--replay-user-messages`、`--session-id`、`--resume`、`--tools`、`--mcp-config`、`--strict-mcp-config`。官方说明 `--session-id` 要求 UUID，`--replay-user-messages` 是接收确认，不能推出模型已处理；`--no-session-persistence` 会失去续办能力，不适用于本目标。[CLI reference](https://code.claude.com/docs/en/cli-reference)
- 官方说明 print 模式会加载本机/项目定制，bare 模式改变发现和认证行为；新版 bare 完整禁止后台仅 2.1.286 起，不能套用到本机 2.1.212。不得为省配置把 OAuth 用户强制改成 API Key，也不得用新版 `--restricted` 或 `--permission-prompts` 参数假装本机已支持。[Programmatic CLI](https://code.claude.com/docs/en/headless)
- 流式输入可支持持续交互，但 Agent SDK 的控制方法不等于本机 CLI stdout 自动提供强一致消费或进程终态；这些仍需适配器与真实样本验证。[Streaming input](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

## 建议验收矩阵

以下为待实施用例，不是通过记录。确定性 fake 子进程、真实 Host 集成、真实 Claude 模型三层分别记录。

| ID | 场景与必要反例 | 预期证据 |
| --- | --- | --- |
| C01 | 配置缺省/非法值/切换后旧执行续办 | 缺省 DSH；非法拒绝；旧成员及其重试后端固定，新成员才用新值 |
| C02 | 同一 cwd 并行两个 CLI 会话并续办 | 明确不同 provider UUID，无 `--continue`，原 ID 原输入历史可读 |
| C03 | 正常工具→阶段 plan→结果→排空 | 真工具前 operation.start、阶段同版本、结果 schema 校验、排空后解锁 |
| C04 | CLI exit 0 但无 submit、坏 JSON、重复/冲突 submit | 失败或幂等；不凭自然语言/exit 0 完成 |
| C05 | 旧租约/错误 task/错误 inputVersion 调用桥 | 派发前拒绝，零实际效果，消息与报告不越界 |
| C06 | 运行中与空闲反馈、同 key 重试、末次提交竞态 | received/consumed 独立、稳定 messageId、真实步骤证据、新反馈阻止旧输出完成 |
| C07 | peer 发给另一 CLI/DSH 成员及终态成员 | 同 task/目标轮次校验；目标终态不复活、不写、不唤醒 |
| C08 | 取消前/工具运行中/后台子进程/父退出子存活 | 所有已托管实体实际结束才 drained；无法证明则占位+锁保留 |
| C09 | PID 重用、出生时间缺失、无关 CLI 进程 | 不结束无关进程；身份不足明确失败，不猜测排空 |
| C10 | Host 在 tool.start 后、结果回写前崩溃 | 重启保留 unknown 原效果，不新身份重放，不释放占用资源 |
| C11 | 真终态 provider 暂态失败与鉴权失败 | 原后端有限持久退避；无鉴权不盲重试、不降级 DSH |
| C12 | stdout 截断/多字节分块/stderr/CLI 版本未知 | 解析不伪造事件；明确可诊断错误，日志限额不丢关键终态 |
| C13 | MCP 未启动/途中断开、工具绕过与额外子代理 | 失败可见，零未登记效果；不能通过其他工具绕过 Host |
| C14 | provider 会话缺失/身份不符/新轮历史恢复 | 保留故障；不偷偷创建新 provider session 替身 |
| C15 | 两轮 plan/result/文档以及重启 | 同轮最终刷新，新轮单独文件，旧 SHA 固定，原报告不冒充本轮 |
| C16 | DSH 回归及混合团队共享资源 | 默认路径不变，持锁到排空，团队总数/反馈/权限边界不回归 |
| C17 | 任务详情及会话记录入口 | DSH 原跳转保持；CLI 后端/真实日志入口可读，失败不伪装成功 |
| C18 | 真实 2.1.212 最小只读模型 run→resume | 独立合成目录、只读固定文件、保存两轮 provider ID 与原文；当前未登录，未执行/未通过 |

## 下一检查点

等待统筹方案明确工具派发前门禁、CLI 日志/终态格式、进程所有权及反馈消费证明。接口定稿后写独立 fake-process 集成反例，完成本轮离线验收；真实只读 run/resume 留待用户后续登录。无法实证的边界保留为未验证，不用单元测试替代真实 CLI 成功。

## 实施接口收敛与独立协议复核

2026-10-22：统筹确定由 CLI 适配器使用 `permission-prompt-tool` 的同步准入回调，显式 enabled tools + forced ask、严格 MCP、关闭 hooks 与 sandbox 自动 Bash allow。该路径依赖真实 CLI 的权限协议；不把旧候选 hooks 的失败放行风险当作已解决的工具事实。

接口固定为 `createClaudeExecutionSessions({ctx,isCurrent,getWorkspaceDir})`，提供 run/cancel/feedback/assertDrained/recoverDrained/close/readProgress。保持逻辑 `task-execution-<UUID>`，CLI 使用其中 UUID；run 回调继续进入现有 Store。独立测试归 `test/claude-execution-session-native.test.js`，通过 `ctx.subprocess` 注入 argv 重写为固定子进程协议夹具，真实管道/HTTP MCP/Windows Job 管理仍运行；不伪称 Claude 模型能力。

已独立读取 CLI 代理的 `docs/tmp/claude-native-contract-probe/probe.mjs` 与 allow/deny/disconnect/invalid 四组 result。真实 2.1.212 对两次 Write 请求均调用权限工具；allow 精确落盘 `synthetic-2\n`，deny/断连/非法结果三组未创建 fixture。四组 CLI 均 exit 0，反证 exit 0 不能代表工具成功或业务已提交。该证据只覆盖探测中的 Write 与权限桥，不外推其他工具、初始化缺失、适配器生命周期或真实模型协作。

独立只读检查当前服务变更：continue 原路径保留 definition 后端；CLI 不再注册/attach 到 DSH JSONL 会话。已向统筹提出 CLI 未知效果的对账应明确保留 unresolved，不进入 DSH 原始日志核验后误报恢复。真实 `LocalSubprocessRuntime` 小进程 smoke 已返回 `{exitCode:0,signal:null}` 且 `waitForExit()===true`，该结果只证明测试基座可用，未覆盖 CLI 或孙进程取消。

## 独立实现验收结果（固定协议子进程）

独立测试已落 `test/claude-execution-session-native.test.js`，以真实锁定 native profile 的 `LocalSubprocessRuntime` 托管 Node 协议夹具；实际 stdin/stdout、HTTP MCP、文件写入、Windows Job 父/孙进程与日志落盘均运行。没有真实 Claude 账户/模型，fake CLI 的 resume 只证明适配器选择原 UUID 和原日志，不证明真实 Claude 历史恢复能力。

| 记录 | 结果与解释 |
| --- | --- |
| `cli-native-independent-1.log` | 首轮 9/9 PASS，0 skip；初步正常/失败/取消/身份路径 |
| `cli-native-independent-2.log` | 扩展轮 14/15 PASS、1 FAIL；正常 Write 后立即 submit 被 `claude_execution_operation_pending` 误拒 |
| `cli-native-ordering-repro.log` | 单独重现同一失败；独立文件观察确认 started 时不存在、settled 时已有精确内容；MCP 提交先于 stdout 结果处理完成 |
| `cli-native-lifecycle-repro.log` | 4/4 PASS；resolve/spawn pending 取消、MCP 在途回调排空、history/session 错配 |
| `cli-native-independent-3.log` | 修复后完整 21/21 PASS，0 skip，11.93 秒；包含先前失败例 |

适配器修复以 `claudecode/toolUseId` 关联 MCP 请求与串行消费的 stdout tool_use；前序 tool_result 及 Host settle 完成后才处理新调用，无 sleep 拼接顺序。另审查确认 readProgress 改为现有 lastSequence/newEventCount/当前 lease 合同，onResult 回传 feedbackVersion；取消无工具结果时 settled(cancelled=true,isError=true) 保留未知效果，真实进程排空仍可证明，避免把未知效果等同于永远活跃的进程。

21 例当前覆盖：Host 提交及对应工具结果；exit 0 缺提交/缺工具结果；provider UUID 错配；旧租约和操作账拒绝的零写入；真实 Write 执行前落账及执行后结算；取消真实父/孙进程（排空后心跳字节不再增长且受测 PID 不可达）；无工具结果的实际写入保留 unknown；原 session 显式 resume 与已绑定日志缺失拒绝；坏 JSON；反馈 ACK 单独不能放行提交、显式读取随机凭据后可提交；旧预生成 Write 不得借后到反馈读取结果放行；当前 lease 的进度观测；未完成日志前缀恢复拒绝且不改写；resolve/spawn 取消竞态；在途 MCP 回调排空；不同 session 的旧日志拒绝；重复 callId 不重放已成功效果。

仍未覆盖/不能外推：真实登录后 Claude 模型 run/resume；真实 CLI 新反馈跨模型请求的全部顺序；所有平台/CLI 版本的工具及进程能力；OS 级权限隔离。真实 binary 的权限协议证据由 CLI 成员另记，与本文件的 fake-process 层分开。测试通过不等于部署、真实钉钉任务或外部业务动作验收通过。

`process-range-audit.log` 的首次 FAIL 也保留：错误预设父进程退出后孙进程仍应存活。`process-range-audit-2.log` 回读证实本机 Windows Job provider 已自动清理其孙进程，前后心跳均 6、waitForExit 为 true。没有以首错删除掩盖过程；最终独立测试另从父/孙确实均活跃的场景验证取消及排空。

独立测试文件当前 SHA256：`4ff62c3692ff6449ce8fdbd6e489f8b7d507d55a3d677b34ecfd1f575b03f0cc`。适配器仍由实现成员继续自审，最终生产文件摘要及全局回归由统筹在冻结后记录；不将当前正在变化的文件冒充所有历史用例的精确已测版本。

## 真实 CLI 两轮离线证据的独立复核

已读 `scripts/verify-claude-adapter.mjs`、`docs/tmp/claude-adapter-native-round-7-first/result.json`、`model-protocol.json`、原始 `claude-events.jsonl`，并以只读 SQLite 直接查询生产 Store 文件及真实目标文件。真实 CLI 版本为 2.1.212，认证只用无效合成值及隔离配置，HTTP 模型回环返回固定工具请求，不能称真实账号模型验收。

原始 journal 同一 provider UUID `237d9156-f34e-4657-813a-510353ac874a`：第一轮 start/bound 为 seq 1/6，Write started/settled 为 9/12，Read 为 14/17，submission 25、drained 32；第二轮 start(resumed=true)/bound 为 33/38，Read 为 41/44，submission 52、drained 59。SQLite 独立回读同 executionId `075438a2-270b-4684-a744-7eeca2c8bc21` 当前 inputVersion=2、succeeded、drained=true，inputHistory 与 results 中保留 v1；唯一 operation 为 succeeded。目标文件精确等于 `synthetic-cli-adapter\n`。

两份 MD 实际存在且包含各自轮次结果：round-1 1919 字节/SHA256 `07db8576eb2cdc1abbf51576185d261c4b8c57721c3e7f358670a4fc41343088`，round-2 1922 字节/SHA256 `65dcbae149731c4ed9fccd28cc2c0ec8f0c1f441d9e5c5cafb294e7af1bfee37`。该脚本没有在切轮前记录旧轮 SHA，故这次独立检查只确认两份现存轮次文档，旧轮字节冻结由既有 SG6 合同覆盖，不从当前两份文件反推本次全过程不变。

发现一个摘要记录缺陷：`launches[1].sessionId` 在没有 `--session-id` 时错误取 argv[0]，应为 null；实际 resume 字段及 journal 都指向原 UUID。已要求实现成员修后续脚本、保留首轮原始材料，不能把摘要错误隐藏掉。脚本明确的实测覆盖为 Write/Read/progress/team/submit/resume；不包含真实多成员 peer 往返、新反馈模型请求、Bash 自动后台、真实登录与业务权限判断。

## 新边界反例：无法证明排空时权限桥泄漏（修复中）

`cli-native-boundaries-1.log` 保留首次失败：4 个断言已通过（无 executable 未 init 后同 UUID 用 session-id 重试；journal hardlink/junction 拒绝并保持目标字节；waitForExit=false 时拒绝结果并保留执行占位），但测试进程未退出。根因是 finally 在 waitForExit=false 处抛出后跳过 HTTP MCP server.close，close() 再次抛同一 drainError 而不释放 listener。已反馈实现成员：关闭权限桥与中止等待者必须无条件执行；排空不足的占位和错误继续保留。

只结束了经 PID/父 PID/命令行核对的本测试子进程 22736（父 37096），其测试 runner 随后 exit 1；没有按进程名批量清理。当前该新增反例未计通过，待修复后单独复验。

## 最终独立回归（泄漏与后台回执修复后）

`cli-native-independent-4.log`：完整 **26/26 PASS、0 skip、exit 0、14.60 秒**。新增 5 例包含 executable 不存在时未 init 的同 UUID/session-id 重试、journal hardlink/junction 两类零写拒绝、无法证明 drain 保留占位但关闭 HTTP listener，以及 Bash 结构化 backgroundTaskId 回执只能记 unknown。上述 listener 泄漏首错已由实现成员修复；此次测试进程正常自行退出，无需强制清理。

`cli-native-independent-4-source.json` 独立记录运行前后 adapter SHA256 均为 `1cb9e0123657080f99b73732115b666072bedb34c9b5b9c08d73589d9ff82a77`；对应测试文件 SHA256 `5f10bef11650440c726a56aa467f543202ee3201b1619ac5fdbd5d3da0200087`。因此本次 26 例结论对应固定源码，不混用先前首错及中间版结果。

本验收成员仅修改独立测试和本执行文档，未提交代码、未部署、未登录。新测试文件的正式 suite-map 更新/检查由统筹统一处理，未并发修改共享映射。真实 CLI+合成模型第二次最终两轮正在由 CLI 成员运行；本验收成员随后只读核对其原始结果。

## 最终真实 binary 两轮只读审结

已独立复核 `docs/tmp/claude-adapter-native-round-7-final/` 的脚本、result、model-protocol、journal、只读 SQLite 与真实文件；结论为 **离线协议层 PASS**。adapter SHA256 `1cb9e012...f82a77` 与 26 例完整独立回归一致。

原 executionId `b351d40d-59ff-4691-91cc-2a4e465dc626`、provider UUID `f84d2e75-508d-4fd1-8498-babaefbd0ad1` 两轮固定。journal 的 start/bound 为 seq 1/6 与 33/38，Write 9/12、Read 14/17 与 41/44，submission 25/52、drained 32/59。SQLite 当前 v2 succeeded/drained、v1 completed 结果保留，唯一 operation succeeded。目标精确回读为 `synthetic-cli-adapter\n`。11 个模型请求均明确记录 bashBackgroundParameterPresent=false；两轮实际启动均带固定禁后台环境参数。新摘要第二轮 sessionId=null、resume=原 UUID，修正了首轮摘要索引错误，首轮材料未覆写。

本次两份 MD 当前 SHA256：round-1 `1789ac8e48ae3502e28c003cbac8a2880a3b60e3884db43b4923ca4442a37759`（1919 字节）；round-2 `79ee0c402058d28332e6d1a9a9d08d7ae4d2f83406d90dc82cd49a26cbd7d2c2`（1922 字节）。同样只确认当前独立文件与各自结果，不补造未记录的切轮前哈希。

最终边界仍明确：真实 binary 和真实 Host/Store 已运行，模型服务为合成回环；Write/Read/progress/team/submit/resume 已证明。真实账号推理、peer/readResources 的真实 CLI 往返、新反馈的真实模型请求顺序、Bash 实际业务命令与部署/钉钉业务均未由此覆盖。已向统筹和实现成员同步审结，独立验收成员停止修改源码和新增验证，等待统筹统一交付。
