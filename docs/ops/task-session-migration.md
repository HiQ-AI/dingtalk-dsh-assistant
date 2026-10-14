> 已废止的历史迁移方案：2026-10-13 用户选择不做旧任务兼容。当前上线请使用 [清洁启动 Runbook](task-session-clean-start.md)，不要执行本文 legacy.import/resolve 或历史接入步骤。本文仅保留旧方案证据。

# 动态任务会话：离线切换、对账与恢复

适用代码：当前 `resident.js` → `task-resident-runtime.js` → `task-session-service.js`。这是操作准备说明，不是已执行的迁移记录；测试通过不表示现场包、进程、生产服务或真实钉钉已验证。

本次新账独立于旧 execution SQLite。旧任务与 Run/节点仅供读取；不自动迁移业务状态、重启旧任务或重新发送通知。旧运行配置、数据库、日志与产物都应保留，不执行删除或历史清理。

## 先确认边界

- 群会话仅关联、交办与必要沟通；唯一任务会话（Owner）只能委派、读结果、取消和提交结论，不能直接调用原生 shell、文件写入、浏览器或数据库工具。
- 执行会话按 `executionId` 单飞，同任务允许多个执行并行；它挂载实际原生 preset、原有工作区指引、沙箱和审批，不自动设置完全权限，首版禁止再委派。
- 任务会话自主判断业务完成。Host 只校验来源、版本、权限、排空、未决 operation 与通知一致性，不再按固定工作流、节点或候选阶段做业务验收。
- Host 对原生操作的最终 unknown 检查与 `operation.start` 转换在同一 SQLite 事务中。若检查明确拒绝派发，只能以原 binding 和原 key 将该条仍为 prepared 的请求标记 cancelled；不能用此路径取消 starting/unknown，也不清除原未知操作。这样原操作可信对账后不会留下不可恢复的未派发占位。
- 未知效果绝不自动重放。超时、进程退出、无 ACK、未找到一条消息、数据库里的 `cancelled` 或重启后没有 Agent 句柄，都不能单独证明外部动作没有发生。
- 旧 schema 升级、storage-domain 格式迁移与本次运行架构切换是不同操作。旧数据不符合其读取 schema 时先单独诊断，不能靠新库 `initialize` 修复旧库。

## 配置与初始化

先记录实际 profile、插件来源/提交或包摘要、DSH 版本、Agent 工作区、storage-domain 后端根、原生 JSONL 根、旧 execution dbPath/instanceId、监听端口与运行 PID。不要从仓库示例路径推断现场路径。

以下是实际 resident 条目的配置片段，须由操作者替换并审阅；不是可直接覆盖的完整 patch。本次只写文档，没有修改任何运行配置。

```yaml
agentWorkspaceDir: 'D:/approved/agent-workspace'
agentPreset: standard
maxConcurrentTasks: 5
taskSessions:
  dbPath: 'D:/approved/agent-workspace/.dsh/task-sessions.sqlite'
  instanceId: 'reviewed-task-instance'
  initialize: false
  legacyDbPath: 'D:/approved/existing-control/execution.sqlite'
  legacyArtifactDirectory: 'D:/approved/existing-control/artifacts'
  legacyWorkspaceDir: 'D:/approved/agent-workspace'
  ownerActorId: '<受信管理者钉钉身份>'
  webActorId: '<已批准Web操作者身份>'
  assistantActorId: '<用于严格通知回读的真实发送身份>'
  maxConcurrentExecutions: 5
  recoveryIntervalMs: 5000
dws:
  enabled: false
  writesAuthorized: false
```

- 默认新库是实际 Agent 工作区的 `.dsh/task-sessions.sqlite`。`taskSessions.instanceId` 未设置时兼容读取旧 `workflow.instanceId`，否则使用内置默认；生产实例应明确配置，避免误认文件。
- `legacyDbPath` 必须指向旧库，不能与新 `dbPath` 相同。若未显式设置而配置中仍有 `workflow.dbPath`，resident 会将它作为只读历史库；保留旧字段不代表旧调度仍启用。
- `legacyArtifactDirectory` 指向旧内容寻址工件根，默认兼容旧 `workflow.artifactDirectory`；`legacyWorkspaceDir` 指向旧任务 scoped 工件所在工作区，默认当前实际工作区。历史正文只读取旧库关联引用并核验摘要，缺失或不可校验时显式 unavailable，不伪造结果。
- 仅已确认的新实例/新账首次创建时显式设置 `initialize: true`。成功后改回 `false`；普通启动默认不初始化。
- 新库旁边的 `<dbPath>.initialized` 是耐久初始化标记，包含实例与初始化身份。标记存在而库缺失时，即使配置仍为 `true` 也报 `DYNAMIC_STORE_LOST`。不要删标记、换路径或换 instanceId 来伪造空账。
- 初始化在创建库前先写 `initializing` 标记。此时崩溃且没有完整有效的库，会保留可辨识的失败状态；不能当作从未初始化自动再建。需停机、取证，按批准的恢复方案恢复同一库/标记；没有数据可恢复时，明确审阅并处理原初始化失败，不把删除标记写成通用修复步骤。
- 原生 `agentPresets`、权限、工具与文件/进程服务由实际 profile 装配。参考 `.dsh/profiles/resident/cordis.patch.yml` 尚不替代以上新库配置；不要重复插入同名 DSH 服务。
- 缺少 Web 受信操作者时拒绝 Web 写入；操作者不是请求正文或模型可自行指定的字段。通知发送身份用于回读核验，不应填写成用户身份。

## 切换顺序

1. 暂停新业务接纳与自动外发，记录正在执行/取消/等待的任务、未知效果、发件箱和实际服务进程。保存核验报告，不改业务状态来“清空待办”。
2. 使用旧版本适用的停机方式停止旧 scheduler、Owner、workflow-service、独立 execution worker/恢复进程和 DWS 自动重发入口。先核对启动配置、服务管理器或计划任务；不要按进程名批量杀进程。
3. 对每个已知执行，要求原生 Agent/工具退出，关闭其受管进程范围，并等待真实排空。普通 subprocess 的 `done` 只证明直接命令退出；需 `terminate()` 后 `waitForExit()` 的 provider 证明。终端用其整个 session 的 termination 结果。对脱离控制、外部 Job、构建或部署继续查原平台，不能从 Host PID 已退出推断它们已停止。
4. 核对原生注册表、已登记会话、子进程/Job/终端、外部操作与监听端口。端口关闭、没有 Agent 句柄和旧库 `drained=1` 都仅是部分证据。任何未确定项保留未决，先不要释放新执行。
5. 停稳后运行下节只读检查，审阅所有旧未决项。旧库、日志和 artifact 文件保持原位；不调用旧 worker 的 `recover`、不重跑旧脚本或旧节点。
6. 安装已审阅的新源码/包和独立 `taskSessions` 配置。旧 scheduler 不再装配；不要同时保留旧运行进程写同一 storage-domain 或 JSONL。新库初建按上一节操作，先禁用 DWS 订阅及外发。
7. 新服务会只读扫描旧库，并把旧未决项导入新库的迁移阻塞账；它不对旧库写 schema、恢复或状态。另从 Resident 历史导入 pending outbox 与未终态旧任务。
8. 检查所有导入阻塞。必要时再次停新服务，按“逐项人工对账”处理；未审阅的项保留阻塞。不要开放新业务再依靠报错保护。
9. 重启后独立读回包/提交、唯一 PID、实际配置、新库身份、任务日志路由、历史只读展示、HTTP 退役响应和恢复状态。用隔离数据验证新任务、并行执行、修订、取消、结果唤醒与通知账。
10. 只有在用户批准的验证范围内才启用真实订阅/发送，并核验真实目标群、消息身份、引用与送达。生产任务恢复、消息发送、部署和合并均不是这份文档自动授予的权限。

`restart-web.ps1`、`deploy-local.ps1` 以及旧 workflow maintenance/cutover 脚本的完整路径仍留作历史资料，其中部分接口已返回 410。本次不得未经核对直接运行其“恢复派发”步骤。新 resident 的正常关闭会停止 HTTP/DWS，再等待任务会话与执行排空；关闭报错时保持停机，不声称已排空或恢复成功。

## 只读检查与证据清单

在仓库根目录、Node.js 24+ 下操作。以下 PowerShell 环境变量必须替换为实际已核对路径；此脚本只以 SQLite `readOnly` 打开既有文件，不运行新/旧 store 的恢复逻辑。

```powershell
$env:TASK_STORE_DB = 'D:/approved/agent-workspace/.dsh/task-sessions.sqlite'
$env:TASK_STORE_LEGACY_DB = 'D:/approved/existing-control/execution.sqlite'
```

<!-- task-session-doc-check: readonly -->
```javascript
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
const inspect = (path, label) => {
  if (!path || !existsSync(path)) throw new Error(`${label}: verified database path is missing`)
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const has = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
    console.log(JSON.stringify({ label, path, integrity: db.prepare('PRAGMA quick_check').all(),
      version: db.prepare('PRAGMA user_version').get(), foreignKeys: db.prepare('PRAGMA foreign_key_check').all() }))
    if (has('dynamic_meta')) console.log(JSON.stringify({ label, identity: db.prepare("SELECT key,value FROM dynamic_meta WHERE key IN ('instanceId','initToken','owner')").all() }))
    for (const table of ['dynamic_legacy_blockers','dynamic_executions','dynamic_operations','dynamic_notifications']) {
      if (!has(table)) continue
      const rows = db.prepare(`SELECT body FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(row.body))
      console.log(JSON.stringify({ label, table, records: rows.map(row => ({ id: row.id, taskId: row.taskId,
        kind: row.kind, state: row.state ?? row.status, resolved: row.resolved, drained: row.drained,
        sessionId: row.sessionId, leaseEpoch: row.leaseEpoch, evidenceRef: row.evidenceRef, source: row.source })) }))
    }
    if (has('execution_nodes')) console.log(JSON.stringify({ label, undrainedNodes: db.prepare('SELECT node_run_id,run_id,session_id,status,drained FROM execution_nodes WHERE drained=0').all() }))
    if (has('execution_effects')) console.log(JSON.stringify({ label, effects: db.prepare("SELECT effect_id,run_id,state,resource_keys_json FROM execution_effects WHERE state NOT IN ('succeeded','failed')").all() }))
    if (has('task_events')) console.log(JSON.stringify({ label, nativeEvidence: db.prepare("SELECT task_id,event_key,turn_id,payload_ref FROM task_events WHERE event_type='native.recorded' ORDER BY seq").all() }))
  } finally { db.close() }
}
inspect(process.env.TASK_STORE_LEGACY_DB, 'legacy')
if (process.env.TASK_STORE_DB) {
  inspect(process.env.TASK_STORE_DB, 'dynamic')
  console.log(JSON.stringify({ marker: JSON.parse(readFileSync(`${process.env.TASK_STORE_DB}.initialized`, 'utf8')) }))
}
```

将上面 JavaScript 原样保存为仓库根目录的临时 `.task-ledger-inspect.mjs`，运行 `node .task-ledger-inspect.mjs`。只检查旧库且新库尚未创建时不设置 `TASK_STORE_DB`。报告只显示索引/状态，不打印工具原始参数、凭据或业务全文；按已有受信 artifact 读取方式另行审阅正文。检查失败先解释真实原因，不切换 `readOnly` 或添加 `immutable` 来忽略 WAL。

逐项至少核对：

| 来源 | 需要的证据 | 当前迁移行为 |
| --- | --- | --- |
| `execution_nodes.drained=0` | 精确 sessionId、原生日志、无活句柄、受管进程范围与外部 Job 排空 | `native-session` 阻塞，不认领原节点 |
| `execution_effects` 非 succeeded/failed | effectId、原请求/外部身份、可信成功/失败/确定未派发证据、资源释放 | 保留状态与资源，不新派发 |
| `task_events.native.recorded` | 此任务所有相关 started/settled artifact、callId/turn/参数身份、结果、取消及排空事实 | **全部按任务导入 `owner-native-evidence` / `unreviewed`，包括已 settled 的历史记录** |
| Resident pending outbox | 原 outboundId、目标群/真实发送者/引用来源、ACK 或开放任务 ID、独立消息读回 | `legacy-notification`；sendStartedAt 存在时 unknown，否则 prepared；都不发送 |
| Resident 未 completed/cancelled 旧任务 | 原任务、Owner 与所有执行/外部操作、是否仍有工作与未决效果 | `legacy-task-not-drained`；不转换为新任务 |

`native.recorded` 导入不是判断所有历史调用都未知，而是账本不能仅凭该事件索引证明所有副作用已结束。即使 artifact 里写着 settled、exitCode 0 或“成功”，仍须审阅相关调用链和真实效果。一个按任务聚合的阻塞只能在该任务全部关联历史原生动作已核对后解除，不能只看阻塞中的第一个 evidenceRef。

当前策略保守：任意未 resolved 的 legacy 阻塞都会全局阻止新执行及新通知分派；并非只影响同名 taskId。读取/UI 可以继续。不要用创建另一个 taskId、删除历史任务或换 operation key 绕过阻塞。

## 逐项人工对账：Host 内部 API

没有公开的“全部忽略”HTTP 接口或自动 resolve 脚本。`legacy.resolve` 是受信 Host 内部账本命令，**执行前须由用户/操作者审阅该精确阻塞及其证据，并明确批准结果**。它只记录历史效果已对账，不恢复旧 scheduler、不重新执行业务、不代表业务验收或消息送达。

可记录 outcome 为 `succeeded`、`failed`、`not_started`。`not_started` 必须有可信的未派发证明；超时、无回执、历史列表中未找到或服务已退出不够。无法确定就不执行 resolve。有关联多个动作时，审阅文件应解释整体对账结论和每项已知结果，而非用一个结果隐藏未决项。

先停新服务，确认没有另一进程持有动态库。以下示例一次只处理一项，不遍历未决列表。新 store 打开会执行自己的机械恢复写入，因此此步骤**不是只读检查**。

准备位于受信本地目录的审阅 JSON，填写真实证据而非示例占位值：

```json
{
  "instanceId": "reviewed-task-instance",
  "blockerId": "从dynamic_legacy_blockers精确复制的id",
  "outcome": "succeeded",
  "evidenceRef": "受信审阅报告的稳定引用",
  "reviewedBy": "实际审阅操作者",
  "reviewedAt": "实际审阅时间（ISO 8601）",
  "approved": true
}
```

`approved` 字段不能由模型或脚本自行补真；它记录已经完成的具体审阅，不代替审批渠道。保留原报告、平台回执与操作者批准证据。

<!-- task-session-doc-check: resolve-one -->
```javascript
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { openDynamicTaskStore } from './packages/dingtalk-dsh-assistant/dynamic-task-store.js'
const review = JSON.parse(await readFile(process.env.TASK_RECONCILIATION_FILE, 'utf8'))
if (review.approved !== true || !review.reviewedBy?.trim() || !Number.isFinite(Date.parse(review.reviewedAt))
  || !review.blockerId?.trim() || !review.evidenceRef?.trim()
  || !['succeeded','failed','not_started'].includes(review.outcome)) throw new Error('Explicit reviewed evidence is required')
const store = await openDynamicTaskStore({ dbPath: process.env.TASK_STORE_DB,
  instanceId: review.instanceId, initialize: false,
  ...(process.env.TASK_STORE_LEGACY_DB ? { legacyDbPath: process.env.TASK_STORE_LEGACY_DB } : {}) })
try {
  const blockers = await store.query({ kind: 'legacy.list' })
  const blocker = blockers.find(item => item.id === review.blockerId)
  if (!blocker) throw new Error('The reviewed blocker does not exist in this instance')
  if (blocker.resolved && (blocker.outcome !== review.outcome || blocker.evidenceRef !== review.evidenceRef))
    throw new Error('An existing reconciliation must not be overwritten by a different review')
  const commandId = 'reviewed-legacy:' + createHash('sha256').update(JSON.stringify(review)).digest('hex')
  const receipt = await store.command({ id: commandId, kind: 'legacy.resolve',
    args: { id: blocker.id, outcome: review.outcome, evidenceRef: review.evidenceRef } })
  const after = (await store.query({ kind: 'legacy.list' })).find(item => item.id === blocker.id)
  if (!after.resolved || after.evidenceRef !== review.evidenceRef) throw new Error('Reconciliation readback mismatch')
  console.log(JSON.stringify({ commandId, replayed: receipt.replayed, blocker: after,
    remainingBlockers: (await store.query({ kind: 'legacy.list' })).filter(item => !item.resolved).length }))
} finally { await store.close() }
```

将 JavaScript 保存为仓库根目录临时 `.task-ledger-resolve-one.mjs`。设置已核对的 `TASK_STORE_DB`、可选 `TASK_STORE_LEGACY_DB`、`TASK_RECONCILIATION_FILE`，经批准后运行 `node .task-ledger-resolve-one.mjs`。只允许重投相同审阅文件/命令，不因结果不确定自行更换 ID。运行后使用上一节只读脚本再次检查；仍有阻塞就保持阻塞，不能报告已全面恢复。

新 operation 的 unknown 使用独立 `operation.reconcile` Host 命令（`operationId`、已证明的 `state`、真实 `result`、`evidenceRef`）；通知使用 `notification.reconcile` 及严格消息读回。它们不由 `legacy.resolve` 代办，也没有自动重发许可。

## 启动与重启验收

1. 验证动态库的 instanceId、初始化标记、完整性与配置路径一致。另一活进程持库、缺表、资源锁不一致、损坏或丢库均应拒绝；不得以新库替代。
2. 新接纳先持久 task/sessionId、来源与分派键；Web 明确操作的 routeDecision 与来源同事务保存。崩溃恢复不能让模型重新解释同一 Web 意图。
3. 读取已持久的 execution.result 与 wake；结果提交失败时两者应同时回滚。领取/确认 wake 只消费本 lease 认领的 IDs，不能吞掉后来事件。
4. 重启将未结束原生会话标为 recovering，旧 lease 不具备新动作权限。执行有 starting/unknown operation 时不恢复模型；否则核对原生日志、身份、无活句柄及无未收工具调用后才证明 drained，再领取新 lease。
5. 原生日志已持久成功 submit、业务账未收时，只重收结果，不再次向模型发同轮输入。更新需求后迟到输出仍保留审计，不回写当前需求。
6. 测试真实取消：确认工具与受管进程范围退出后才释放占位。一个清理失败不能阻止尝试清理其他句柄；任何未证明项继续报未排空。
7. 业务完成后检查独立 notification 状态。重启后的 unknown 通知只能查原发送与真实消息，不应二次 send；来源、群、发送者、引用与 mention 必须可核验。过期问题不得发送。
8. 检查旧工作流/变量管理/阶段控制 API 返回 410；旧任务保持只读，而不是隐藏了按钮但写接口仍可调用。

可在隔离环境运行：

```powershell
node --test test/dynamic-task-store.test.js test/dynamic-execution-session-native.test.js test/task-session-persistence-native.test.js test/task-session-service-native.test.js test/task-session-http-integration.test.js test/task-filesystem-boundary-native.test.js test/task-notification-readback.test.js
```

这些测试包含真实原生 Session/preset、SQLite、进程与故障夹具，仍不替代现场模型、Windows Job/Linux provider、DWS、浏览器或业务平台验收。此文档的 JavaScript 检查/单项对账示例另在临时 SQLite fixture 执行验证；PowerShell 包装在无 PowerShell 的云测试环境未实跑。

## 备份恢复与回退边界

以下说明一致恢复集，不要求每次本地部署另建历史副本；按既有备份策略保留必要状态。数据迁移、恢复和删除需单独审阅。

一致恢复至少包括：

- 动态 SQLite 主库及其有效 WAL 状态、`.initialized` 标记；停写后一致复制或使用经验证的 SQLite 备份方式，不能单独复制正在写入的主文件后丢掉 WAL。SHM 是协调文件，不可作为业务数据或排空证据。
- `tasks/.session-routes/` 与各 `tasks/<taskId>/.dsh/sessions/` 原生后端文件；它们共同决定会话在哪个后端恢复。日志不能仅保留摘要、数据库里的 sessionId 或人工导出副本。
- 各任务 `materials/`、`work/`、`outputs/` 与恢复仍依赖的 `tmp/`，以及文件证据引用指向的其他批准位置。不能笼统排除执行工作目录后还承诺原任务完整恢复。
- 旧 execution 库、旧 artifact 目录、旧原生 JSONL 根、storage-domain 群/来源/outbox 历史、实际 profile 和受信凭据服务的独立恢复方案。凭据不放进任务日志、审阅报告或仓库。
- 群会话日志仍在实际原生持久化配置根；群 cwd 在工作区 `groups/` 并不表示日志也在那里。

恢复须保持 taskId、executionId、sessionId、实例身份、绝对工作目录绑定与路由一致。在线换根会被拒绝；离线换根也不是简单复制日志再改一个配置值，必须单独核验已持久的 cwd 和路由。没有受支持的迁移流程时保留原根，不编辑日志身份绕过检查。

代码回退不等于数据回退。新架构一旦接纳来源、启动 operation 或发送通知，直接启用旧 scheduler 可能重复业务。应先停稳、逐项对账新旧效果和通知、保留新账/原生日志，再由操作者批准明确的回退范围。绝不能删除新库、标记或 task 目录来恢复旧版本的“空状态”。

## 隔离与后台执行的真实限制

原生文件工具经 Host 公有 FS 能力做 lexical/canonical/symlink 路径校验，保护其他任务材料、其他执行私有 cwd、`.dsh`、中央 session routes 与配置的控制库/WAL/SHM/marker 路径。预检拒绝发生在 operation 分派前，不把明确越界请求登记为未知外部效果。

这不限制任意 shell 程序通过变量、相对路径或系统调用读取宿主允许的位置，不构成恶意代码 OS 租户边界。不要把“一个任务一个目录”宣传为相互不信任任务的强沙箱。需要这种隔离时必须另配真正的 OS/provider 权限与容器/用户边界并独立验收，当前实现不自动提供。

首版拒绝后台/脱离参数；原生工具隐式返回后台 job 时明确报不支持，其已纳管进程按 provider 范围停止并等待，不视为成功构建。由服务外自行启动、脱离 provider 的进程或远端工作不因本地句柄排空就消失；有此情况继续保留未决操作并人工核实。当前代码不能承诺 Windows Job 或 Linux provider 所不提供的范围保证。
