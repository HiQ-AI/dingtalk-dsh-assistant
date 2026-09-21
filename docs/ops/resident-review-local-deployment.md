# 常驻通知修复本地部署

本 runbook 用于未发布修复包在现有 Windows DSH `web` profile 的安装与验证，不升级 DSH、模型、OAuth、代理或其它插件。沿用[源码开发安装说明](../manual/install-and-configure-dsh-web.md)的原生插件安装路径。组织权限由负责人处理，本轮不重新登录、不主动重试或补发真实群消息。

## 安装前自检

1. 跑本轮回归和 `node scripts/build-web-client.mjs`，确认生成文件与源码一致。
2. 读取 `%USERPROFILE%/.dsh/profiles/web/package.json`，保存 Assistant/Observer 两个依赖的原值用于回退；对 profile patch 和任务流程配置计算摘要，不记录凭据或消息正文。
   本次协调修复还需对确认过的当前 `dingtalk_dsh_assistant` v8 JSON 文件做只读预检。先在脱敏副本验证，也可直接读取原文件；脚本不会打开 Domain 写入接口，不改原文件，不输出正文、记录 ID、凭据或源路径：

```powershell
node scripts/check-resident-storage.mjs --check --source '<已确认的v8存储文件或副本绝对路径>'
```

   必须退出码为 0 且 `ok: true`；输出各表数量、扩展字段数量、校验错误代码计数及 `strippedFields`。`strippedFields > 0` 表示当前 Schema 会丢字段，不能忽略后继续切换。运行中存储可能变化；停止已核实的实例、排空写入后，先把完整存储备份到仓库外受保护目录并记录 SHA256，再对稳定原文件重跑预检。备份包含业务消息和授权内容，禁止提交 Git。脚本只验证当前 Schema 可读且不剥离已有字段，不替代 Topic 引用和业务完成证据验收。
3. 确认 `%USERPROFILE%/.dsh/profiles/web/node_modules/@deepseek-ai/dsh/lib/bin.js` 存在。本机全局 `dsh.ps1` 曾指向已删除目录；本 runbook 固定使用 profile 内的原生 CLI，不依赖全局 shim。查询 3080、18998 listener，确认同属当前 DSH Web 进程，记录 PID。检查进程与端口后才能停止该实例，不结束其他 Node/DWS 进程。
   同时读取 `node_modules/.modules.yaml` 的 `virtualStoreDir`，确认它指向当前 profile 下的 `node_modules/.pnpm`。若 DSH_HOME 或 profile 曾迁移、该路径仍指向旧目录，先停机并在当前 profile 执行 `pnpm install --force` 重建依赖树，再运行原生插件安装；不得整体链接或复制旧 profile 的 `node_modules`。重建后按 loader 的实际 import 核对必需 peer 是否已安装，缺失时安装项目声明的精确兼容版本并重新启动验证，不能仅因插件安装命令退出码为 0 就判定可运行。
4. 在 `docs/tmp/` 下创建本次唯一打包目录（包含本轮提交标识），按实际修改打包内部包。本次协调修复只修改 Assistant，Observer 保持原依赖；同时修改两个包的任务才执行两条命令：

```powershell
pnpm --dir packages/dingtalk-dsh-assistant pack --pack-destination ../../docs/tmp/<unique-directory>
pnpm --dir packages/dingtalk-dsh-observer pack --pack-destination ../../docs/tmp/<unique-directory>
```

独立回读两个 tgz 文件大小和 SHA256。不得覆盖此前同路径同名包后依赖缓存刷新。

## 安装与启动

1. 停止已核实的 DSH Web PID 及仅属于该进程的 DWS 监听子进程，避免遗留重复监听；将新 tgz 绝对路径传给 profile 内的原生 CLI：`node "$env:USERPROFILE/.dsh/profiles/web/node_modules/@deepseek-ai/dsh/lib/bin.js" plugin --profile web add <assistant.tgz> <observer.tgz>`。
2. 回读 profile 的两个依赖，逐一比较安装目录与工作区源码及 patch 文件的 SHA256，确认原有 profile patch 未变。`pnpm pack` 可能移除 `package.json` 末尾换行：manifest 按 JSON 内容或仅去除末尾空白后比较，其他差异仍必须调查，不能一律忽略哈希不一致。
3. 若启用了任务表格同步，重启后回读 `/state/task-sheet-sync`，确认配置中的 nodeId/sheetId 未漂移、启动同步成功，并用 `dws sheet +read` 完整回读托管范围。`/health`、CLI 退出码或设置页提示均不能替代表格内容核对。
4. 按现有 `scripts/start-web.ps1` 启动；后台 PowerShell 进程使用 `Start-Process -WindowStyle Hidden`。stdout/stderr 只存本地 `docs/tmp/`，日志可能含登录链接，不进入 Git。
5. 启动地址在 loader 完成后才输出，端口出现不代表地址已可读取；先确认日志包含地址再做认证访问，不把空日志当作启动失败。确认两个端口属于新进程，检查 `/health`、`/state/agent-config` 与 Web 认证访问。配置摘要应保持一致；health 的组织权限错误需单独说明，不能将其写成插件测试失败或真实投递通过。

## 验收与回退

Topic 决策输出预算版本在安装前须完成工具协议与长历史回归。安装后只读确认运行包中的 `topic-runtime.js` 与本次源码哈希一致，并观察新产生的路由回执仅含请求标识、决策首屏不超过 12 KiB；超长事项可由 `group_decision_context_get` 按固定请求连续读取，必要依据未读完时决策应被拒绝。不要为验证而重放现有群消息、Task 动作或历史 Outbox。若还有运行中的本机 Task，应保留当前服务，等 Task 安全结束后再按本 runbook 切换。

替换链修复需同步安装 Assistant 和 Observer 当前包（仅状态说明变化，不调整页面布局）。停机前后对实际 Outbox 使用 `reconcileReplacementGraph` 做纯函数预检，引用缺失、环或不可比较分叉不允许跳过。安装后核查旧意图 superseded、最新通知真实 deliveredMessageId、撤回失败独立状态及尝试次数不再无限增长；查询未命中不能视为从未发送。新增 superseded 枚举同样禁止旧二进制直接写新存储。不得手工删记录、置 sent 或批量重发来通过验收。

阶段决策修复部署还需回读：失败意图是否转为 `rejected`、新决策是否完成、Topic `processedRevision` 是否追平、原消息是否收口、叶子报告是否从 `input-wait` 经版本归档或审阅得到终态，以及同一 Task 是否产生后续执行事件。不能仅凭 Session 文件增长或端口就绪判定恢复。新阶段身份不会跳过计划审阅；历史坏意图不手工改 stageId。新版本增加 decision 的 `rejected` 终态，旧版本 Schema 不支持该值，不得换回旧包对已更新存储继续写入。

源码测试、安装包一致性、启动、认证访问、看板合成数据验证分别留证。真实 DWS 投递保持未验证，不改 pending 状态来使看板变绿。

叶子职责边界修复部署前，先只读查看 `/state/tasks` 中的活动与等待 Task，核对是否存在历史 `waitingKind=coordination`，以及仅等他人后续检查的其他等待报告。旧 `coordination` 结果仍可读取，但新版不再提交或补发该检查请求；不要直接改存储 JSON 或批量把等待改成完成。对确认属于误扩范围的任务，使用受管的版本化任务修订，保留已完成的阶段证据，再由叶子按新版本提交结果。安装后分别核验等待审阅、Task/Goal 状态、Outbox 投递与实际业务证据；已有 Task 完成不因后续检查未回复而回退。

当前协调修复使用 Domain 版本 **8**，通过可选字段和默认值读取旧记录：Task 的 `activityProjection`、`stagePlan`，Group 的 `coordinationRequests`，活动的 `seq`，以及 `executionEvents` 内报告接收、审阅、处理、通知状态。旧字段和历史检查点保持可读，不运行全库迁移。首次恢复活跃旧任务时，从其已批准计划补齐阶段索引，记录 `stage-plan-reconciled` 与旧阶段数组；不更改原检查点、审批、inputVersion 或结果。没有已批准计划不补造阶段。`--check` 只验证读取兼容性与字段保留，启动规范化由两次重启幂等测试单独覆盖。

活动投影故障核验：注入短暂写入失败后，确认同一 Session 原事件按序补齐、`/state/recovery-issues` 当前活动故障解除；持续写入失败时应保持 degraded，不能仅凭较新活动存在就判定恢复。任务完成时仍保留故障 Session 以供监督器补齐；部署前产生的旧活动缺口需单独核对，不把新版重试机制当成历史回填证明。

新版启动后，监督器逐个读取已完成 Task 的持久 Session，审计并补齐活动投影；历史已裁剪的 500 条明细之前的数据无法恢复，统计覆盖范围应保留 `retained-only` 标记。观察 `activity-projection` 恢复问题和投影水位，不以 health 短暂为 healthy 代替队列审计完成。Outbox 的发送尝试、回读尝试和投递轮数分别核对，`deliveryAttemptCount` 不能推断重复群发。多 Unit 消息的任务派发还需检查 `dispatchAssessment` 来源 Unit 与当前流程版本。

历史已完成 Task 的 Session 若被清理，`/state/activity-audit` 将列为 `session-not-found`、不再无限重试；`/health.activityAudit` 汇总 pending/audited/unavailableCount。不可回填属于历史证据缺口，不等于当前投影写盘失败；若 pending 长期不降或 `/state/recovery-issues` 保留活动故障，仍需检查存储和 Session 持久化。

**不能仅换回旧二进制并继续写原存储。** 旧 Schema 可能在更新 Task/Group 时剥离这些新字段，造成通知恢复、水位或审阅状态丢失。曾写入新状态后，应先停止写入，保留当前完整文件和安装前备份；优先前向修复。确需降级时，先在隔离副本证明目标版本不会丢新字段、不会重放外部动作，再允许恢复写入；未证明之前保持停机或只读查看，不启动旧版可写实例。

不得直接恢复安装前快照覆盖切换后新产生的审批、通知或外部动作记录。回退包本身仍走原生插件安装并独立核对依赖和文件摘要，但包回退不等于存储已安全回退。若新旧存储不能无损转换，保留现态完成前向修复。

## 信息等待与阶段进度修复验收

安装前只读核对运行任务与等待任务，运行中 Task 不得被重启中断。使用隔离 Store 验证旧记录保留、跨序已审阅阶段登记、等待通知送达前不提醒、30 分钟与 2 小时有限跟进、恢复后旧 pending 通知失效。安装后只读回读 /state/tasks 和 /state/groups 中当前等待及 Outbox，群通知必须凭 deliveredMessageId 与 DWS 原消息独立确认；旧等待已有 sent 记录时不重发原询问。当前 method-select Task 只按受管版本化补充恢复已取证阶段，循环次数仍缺真实会话证据时保持未验证。


历史已发送旧式询问不会在启动时批量补发或自动催促。仅对核对过的当前信息等待 Task，可调用 POST /tasks/<taskId>/information-wait-notice 一次性登记明确暂停的更正通知；先独立确认旧询问的 deliveredMessageId、任务仍 waiting 且结果未变化。接口返回 enqueued 只表示 Outbox 落盘，随后必须读回新消息 deliveredMessageId 和 DWS 原消息；重复调用只复用同一稳定键。当前案例为 task-7e10fc01558bb150f5224affeb5196e4，勿对其他历史任务批量调用。

UAT2 角色菜单组任务 `task-ecf5a0c74b07381abba1330a4ebb4551` 的计划检查点曾因 `topic_context_budget_exceeded` 循环拒绝。切换前先只读回读当前状态、备份并对稳定存储运行 `scripts/check-resident-storage.mjs --check`；切换后确认 `topic-runtime.js` 哈希为本次源码，再检查该任务是否产生新的计划审阅、已确认阶段或明确终态。仅修复分页预算不等于业务菜单配置完成；不得手工写入检查点或任务完成状态。停机前若还有其它运行中任务，要分别判断是否可安全中断。

本轮系统故障分类修复需验证：固定审阅预算错误落为 `failed`，Task 进入 `waitingKind=system`，原 `submissionId` 和已确认阶段保留；同错误的新提交不会反复排队。核查 `task-system:<taskId>:<runSequence>:<inputVersion>:<code>` Outbox 只有一条；只有确认当前修复包已经装入且任务仍为同一版本时，才通过原报告的 retry API 重试。retry 会占用一个运行名额；其它 Task 占满并发时应等待空位。故障通知已 sent 时回读 deliveredMessageId，pending 且任务已恢复时必须 superseded。旧二进制的 Task Schema 不认识 `waitingKind=system`，写入这种状态后不得直接降级到旧包继续运行。
