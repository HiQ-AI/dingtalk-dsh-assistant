# 执行底座与消息工作流本地运维

第 1—8 节记录独立执行底座的装配与边界，第 9 节为当前 resident 消息工作流的正式切换步骤。独立入口与 resident 集成入口不能同时对同一控制库持有写者。以下 M1/M2 描述仅适用于独立装配，不代表第 9 节集成入口仍缺少消息、通知或工程适配器。

M1 对应的独立执行入口 `@zzusp/dingtalk-dsh-assistant/execution`。它**不默认加载**，不读取或迁移 resident 的 Task 账；现有群消息、Web 看板和 resident 流程继续使用原入口。当前仅准入受信定义的 `pure/read` 顺序节点，用于隔离环境中的合成任务与受控读取。

M2 增加了显式注册的本地 Git 交付适配器，见第 7 节；默认未注册时仍只准入 pure/read。没有生产发布、SQL、钉钉发送或 shell 作业启动适配器。不得将现有生产任务、工程 shell、凭据操作或旧存储迁入本入口；工具白名单与独立目录不构成操作系统隔离。局部测试不代表真实模型质量、渠道送达、整体时延、token 成本或完整业务链已经验收。

## 1. 离线初始化

使用包含 `./execution` 导出的构建、Node.js 24 及其内置 `node:sqlite`。选择独立的本地数据目录、固定实例标识和独立 DSH Session 持久目录，不使用网络共享路径，也不复用 resident 的数据文件。安装环境需具备本项目依赖和原生 DSH 服务；不在本流程修改模型凭据。

以下 PowerShell 命令在仓库根执行。先将占位符替换为本次隔离实例的**绝对路径**和固定 ID，参数通过命令传入，不写入环境变量：

```powershell
$executionDb = '<控制库文件绝对路径>'
$executionArtifacts = '<工件目录绝对路径>'
$executionInstance = '<固定的隔离实例ID>'

node scripts/init-execution-store.mjs --db $executionDb --instance $executionInstance --artifacts $executionArtifacts --check
```

确认输出为 `CHECK_PASS`、解析后的路径正确、`writes: 0`，且这些位置不属于现有实例，再执行：

```powershell
node scripts/init-execution-store.mjs --db $executionDb --instance $executionInstance --artifacts $executionArtifacts --execute
```

脚本拒绝已存在的数据库；`--check` 不是数据库、原生服务、权限或模型连接的完整自检。`--execute` 建库后才创建工件目录，故初始化中途失败可能留下数据库：保留失败证据，检查目录/权限和实际产物，不能用反复初始化或删除原库来绕过错误。

正常启动不传 `initialize: true`。Cordis 入口显式拒绝在线初始化；缺库、空库、错误 instanceId、未知 schema、完整性或外键异常均停止开库，不回退 JSON，也不补建缺失表。

## 2. 受信工作流插件

工作流由经审阅的插件代码提供，不能来自消息、模型生成代码或可随意编辑的业务 JSON。定义插件通过 `ctx.provide('executionWorkflows', [...])` 提供固定顺序列表。示例为一个 code 节点和一个 Agent 节点；Provider/模型占位符须替换为隔离 Host 已配置且允许使用的 ID：

```js
// execution-workflows.js：受信插件源码示例。
export const name = 'local-execution-workflows'

export function apply(ctx) {
  const requestSchema = {
    type: 'object', properties: { text: { type: 'string' } },
    required: ['text'], additionalProperties: false,
  }
  const textSchema = { type: 'string' }
  const resultSchema = {
    type: 'object', properties: { summary: { type: 'string' } },
    required: ['summary'], additionalProperties: false,
  }

  ctx.provide('executionWorkflows', [{
    id: 'local-summary', version: '1',
    nodes: [{
      id: 'normalize', version: '1', executor: 'code',
      allowedEffects: ['pure'], inputSchema: requestSchema, outputSchema: textSchema,
      mapInput: ({ requirement }) => requirement,
      execute: async ({ input, signal }) => {
        signal.throwIfAborted()
        return input.text.trim()
      },
    }, {
      id: 'summarize', version: '1', executor: 'agent',
      allowedEffects: ['pure'], inputSchema: textSchema, outputSchema: resultSchema,
      mapInput: ({ previousOutput }) => previousOutput,
      provider: '<已配置Provider ID>', model: '<已配置模型ID>',
      prompt: '概括输入文本。完成后调用 execution_node_submit，output 为含 summary 字符串的对象。',
      allowedTools: [], maxSteps: 32, timeoutMs: 120000,
    }],
  }])
}
```

每个节点必须有独立 ID、版本、`inputSchema/outputSchema` 和 `mapInput`，code 节点还需 `execute`。schema 使用原生 `dsh-tools` 支持的 JSON Schema 子集。下游只取得经校验的前驱输出，不解析上一节点的聊天历史。普通模型最终文本不代表节点完成；Agent 通过 `execution_node_submit` 提交输出，Host 在工具排空、schema 和身份检查后接纳。

工作流 digest 覆盖固定定义、mapper/实现、schema、模型、提示和工具清单。修改规则或实现时更新定义版本，并保留在途任务需要的原版本；恢复找不到相同 workflow digest 时会报错，不可把同名新定义冒充旧定义。不要在不改版本的情况下改变函数依赖的外部可变配置。

### 在隔离 Host 中显式装配

Host 必须已经提供 `agents`、`agentLoop`、`sessions`、`sessionPersistence`、`sessionProjections`、`llm`、`tools` 和 `systemPrompt`。定义插件先提供 `executionWorkflows`，再注册包的 `./execution` 入口。下面展示对应的受信装配调用；它不是群命令或 Web API：

```js
import { apply as provideWorkflows } from './execution-workflows.js'
import { apply as installExecution } from '@zzusp/dingtalk-dsh-assistant/execution'

provideWorkflows(ctx)
await installExecution(ctx, {
  dbPath: '<与离线初始化一致的控制库绝对路径>',
  instanceId: '<与离线初始化一致的实例ID>',
  artifactDirectory: '<与离线初始化一致的工件目录绝对路径>',
  readTools: [],
  maxConcurrentRuns: 4,
  changeQuietMs: 2000,
  maxChangeDelayMs: 10000,
})

const { controller, store, artifacts } = ctx.execution
```

`readTools` 是 Host 审阅后允许的工具名清单，默认空；每个 Agent 的 `allowedTools` 必须是它的子集。工具名字含“read”不构成只读证明，Host 仍须核对实际实现。`execution_node_submit` 由节点适配器注册，不放入 `allowedTools`。code 函数也是受信代码，声明 `pure/read` 不会自动限制其 Node.js 权限。

## 3. 创建、替换输入与查询

调用方持久保存每次动作的 `commandId`，超时重试必须复用原 ID 和完全相同的参数。相同 ID 不同内容会冲突；需要新业务动作时才使用新 ID。以下 ID 都是合成示例：

```js
await controller.createRun({
  commandId: 'demo-create-001', taskId: 'demo-task-001', runId: 'demo-run-001',
  workflowId: 'local-summary', input: { text: '待概括的合成文本' },
})

const state = await controller.state('demo-run-001')
```

`state()` 读取当前 run、节点、输入屏障、等待原因和 Controller 错误，不调用 LLM。也可从受信服务读取 `store.query({ kind: 'run', runId, includeHistory: true })`；此处的状态接口尚未接入 resident HTTP 页面或钉钉回复。

调整使用**整份输入替换**，不是在旧输入上追加字段或让模型猜测合并：

```js
await controller.changeInput({
  commandId: 'demo-change-001', runId: 'demo-run-001',
  inputId: 'demo-input-002', sourceKey: 'synthetic-request-002',
  input: { text: '替换后的完整合成文本' },
})
```

先持久接纳并建立屏障，再中止/排空旧执行，在合并窗口后使用最后一份完整输入建立新 generation。当前 Controller 从首节点重算整条链，不提供语义级补丁合并；每条已接纳输入仍留在账中。同一来源的重复输入不额外换代。不能用此接口自动重开已完成 run。

`whenIdle(runId)` 等待当前调度结束并返回状态；`waiting`、预算耗尽或错误也可能让调度空闲，所以不能仅凭它返回就宣称任务成功。须核对 `run.status`、有效节点输出及对应证据。

## 4. 当前默认预算

| 项目 | 默认值与实际边界 |
| --- | --- |
| 并发 run | 4；允许配置为 1—32 |
| Controller 待调度队列 | 最多 256 项 |
| 工作流 | 最多 32 个顺序节点，仅 code/agent；独立底座示例只用 pure/read，已准入的工程 code 节点可声明受控 Git/工作目录/PR 效果，外部流程 code 节点可声明 `external.operation`，均须相应受信适配器 |
| 输入替换合并 | 静默 2 秒、首条起最长 10 秒；它是合并参数，不是业务完成时限 |
| 整个 run 的 claim 次数 | 默认节点数 × 3，恢复和换 generation 不重置已用次数；不是每个节点各自无限重试 |
| Agent 每次执行 | 默认最多 32 step、120 秒；maxSteps 允许 1—256 |
| code 节点 | 没有上述 Agent 定时器，必须主动响应 AbortSignal 并使操作有界 |
| Store RPC | 最多 64 个待回复请求，单请求 JSON 最多 256 KiB，启动/请求超时 10 秒 |
| 单个 JSON 工件 | 最多 64 KiB；完整落盘后登记内容地址，读取重新校验 hash |

本批没有落实 v2 全部 token 预算和性能目标。预算耗尽会留下等待/恢复原因，不通过 Goal 续轮、换代或重新批准偷偷清零。调整参数属于受信 Host 配置变更，不能由 Agent 修改。

## 5. 停止、重启与显式恢复

```js
await controller.stop({
  commandId: 'demo-stop-001', runId: 'demo-run-001', reason: '结束本次合成实验',
})
const stopped = await controller.whenIdle('demo-run-001')
```

停止回执只表示 stop 已持久接纳；实际执行未退出时保持 `cancelling`，不能改成 `cancelled`。Host 关闭时先取消并排空 Controller/原生句柄，再关闭 Store。code 函数若不配合取消，排空可能持续等待；不能靠手改 `drained`、删除锁或启动第二个写者来假装结束。

重启会把在途节点记为恢复等待，不自动调用模型。人工核对原因、会话身份、实际句柄和未决效果后，由受信 Host 显式调用：

```js
await controller.recover({ commandId: 'demo-recover-001', runId: 'demo-run-001' })
const recovered = await controller.whenIdle('demo-run-001')
```

`recover` 不能覆盖停止、输入屏障、预算或 unknown 效果。已持久的输入替换和停止优先收口。原生会话的固定身份、历史租约和持久记录必须匹配；已绑定 Session 丢失、身份异常或旧句柄仍活跃时进入明确错误，不新建空会话伪装续接。

### 效果与审批边界

同库效果协议已经定义操作/job 身份、资源占用、授权依据、开始许可和观测回执，尚未接入真实发送或 shell 适配器。适配器只能使用本次正式命令返回的顶层 `dispatchEligible: true`；历史 begin 回执中的 `result.started: true` 不构成新许可。

Web/钉钉首次审批决策在内部协议中平级：同 request 首个有效终态生效，actor 必须匹配请求白名单；先撤销的 tombstone 会挡住晚到批准。**本批没有 Web/钉钉认证与审批渠道接入**；`actorId` 和 `authorizationRef` 必须由受信 Host 取得，字段本身不是认证证明，也不接受 `authorized: true` 代替授权依据。

`starting/executing` 在重启后变为 `unknown`，包括作业启动许可已持久、PID 尚未回写的窗口。unknown 保留资源占用，只能按原身份观察和对账，不自动重派。进程不在、请求超时或没有回执都不等于效果没发生；此批没有通用人工“强制解锁/重试”入口。迟到真实回执仍需入账，不能因为旧 generation 失效而丢弃。

## 6. 严格开库与人工排障

正常开库校验实例和 schema 身份、SQLite 完整性/外键、业务字段、未决效果和资源占用，并回读 WAL、`synchronous=FULL`、foreign keys 配置。独占保护使用同路径 `.owner.sqlite` 的真实 SQLite 文件锁，不靠端口或 PID 文件判断。

| 现象/错误 | 处理依据 |
| --- | --- |
| `STORE_DATABASE_MISSING` | 核对绝对路径、部署配置和文件是否存在；既有实例不能靠重新初始化修复 |
| `STORE_OWNER_LOCKED` | 找到同一库的现存 Host 并正常排空关闭；锁文件存在本身不等于陈旧锁，禁止删文件解锁 |
| `STORE_INSTANCE_MISMATCH` / `STORE_SCHEMA_MISMATCH` | 核对 instanceId、包版本、数据库来源；不手改标识或用旧版本继续写 |
| `STORE_INTEGRITY_FAILED` / `STORE_FOREIGN_KEY_FAILED` / `effect_*_invariant` | 停止执行准入，保全数据库/工件/Session 和错误记录，在隔离副本定位，禁止跳过坏记录 |
| `COMMIT_ACK_UNKNOWN` / `STORE_UNAVAILABLE` | 停止派生效果，关闭后按原路径重开恢复，先以原 commandId 查询 receipt；超时不是未提交证明 |
| `WORKFLOW_VERSION_UNAVAILABLE` | 恢复对应固定定义和版本；不将新同名定义套到旧 run |
| `execution_session_missing` / `execution_session_identity_mismatch` | 核对原生 Session 持久目录、固定身份和包版本；不删记录或新建空 Session 绕过 |
| `EXECUTION_BUDGET_EXHAUSTED` / `controllerError` / 节点 recovery 等待 | 读取具体原因与已有证据，修复实际问题后按契约恢复；预算耗尽没有自动续期 |
| `run_effects_not_drained` / `node_effects_not_settled` | 检查未决操作/job、审批和资源持有者；完成独立对账前不能标任务结束 |

回执只读查询示例：

```js
await store.query({ kind: 'receipt', commandId: 'demo-create-001' })
await store.query({ kind: 'effect.list', runId: 'demo-run-001' })
await store.query({ kind: 'safety.get' })
```

排障材料只留错误代码、脱敏身份、版本和必要摘要，不公开消息正文、凭据或本机个人目录。备份应使用 SQLite 一致性机制，或在所有相关写者已停稳后保全数据库及关联工件/Session；不能只复制运行中的主 `.db` 文件。M1 没有自动迁移或备份恢复命令，恢复旧快照前必须核对其后实际效果，不能抹掉新审批和未决操作再执行。

本入口源码、合成测试、真实服务接线、生产部署、渠道回读和性能验收分别留证。只有对应层实际通过，才记录该层完成。

## 7. M2 本地候选与受控 Git 交付

包的 `./execution` 入口导出 `freezeCandidate`、`readCandidate`、`verifyCandidate` 和 `createGitDelivery`。M2 已提供第 8 节的受管代际目录；跨代自动清理不在本节范围。第 9 节 resident 集成另有固定命令检查、GitHub PR 与通知适配器；工程能力必须通过 workflow.repositories 显式准入，不能把本节独立示例当作完整工程配置。

### 冻结与验证

`freezeCandidate({repository,baseCommit,generation,requirementDigest})` 对受管仓库的 tracked/untracked 文件及删除生成完整 tree，使用临时 index，不创建临时 commit，不改用户 index 和工作文件。冻结前调用方必须持有写 lease 并排空写者；它不是对并发修改目录的原子拍照。新代应通过第 8 节从有效基线准备新受管目录，不能把失效旧目录直接再次冻结。

`verifyCandidate({candidate,checks:[{id,version,run}]})` 的 run 只取得固定 tree 的文件列表及 readFile。日志和 passed 是显式结果；默认没有 shell 测试。检查函数来自受信插件，不构成操作系统沙箱。文件上限16 MiB、全部文件64 MiB、10000项；不支持符号链接、子模块或适用的执行型过滤器。

验证成功票据由本进程创建并冻结，复制出来的普通 JSON 不算可信票据。`prepareCommit` 要求这张真实票据和精确 requiredChecks；重启时尚未准备交付的候选需重新运行只读检查。已经持久准备的动作使用原 payload 对账，不能因票据不在内存就重发写操作。

### 受信 Host 装配

```js
const adapter = await createGitDelivery({
  repository: '<受管源仓库绝对路径>', remote: '<本地bare远端绝对路径>',
  branch: 'delivery', author: { name: 'Synthetic', email: 'synthetic@example.invalid' },
})
ctx.provide('executionDelivery', {
  adapter,
  // 此回调必须查询实际任务授权；没有授权返回null，不接受模型自报。
  authorize: async ({ binding, action, prepared }) => lookupTaskGrant(binding.taskId, action, prepared),
})
```

定义插件应在装配执行入口前提供此服务；直接使用 openExecutionRuntime 时传 `deliveryOptions`。上述回调是接线示意，`lookupTaskGrant` 必须由 Host 实现。authorizer 返回 `{principalId,authorizationRef}`；这不是新增人工确认环节，已有明确任务授权可以直接复用。静态授权示例不得用于真实用户入口。

只有 code 节点可以声明 `allowedEffects:['git.commit']` 或 `['git.push']`；Agent 声明会被拒绝。受信 execute 回调取得 Host 的 generation、requirementDigest 和 `perform({action,prepared})`。candidate 必须使用这些身份；不能使用另一任务的同代候选。每个节点每种动作只有一个固定 operation 身份，需要多次不同动作应拆节点。

顺序为：冻结 → 真实只读验证 → `adapter.prepareCommit({candidate,verification,requiredChecks,message,date})` → commit 节点 `perform` → `preparePush({commit,expectedRemoteSha})` → push 节点 `perform`。date 是首次计划时冻结的 Unix秒+时区字符串（例如 `1790150400 +0000`），必须持久复用，不能每次恢复取当前时间。prepared 含验证检查、版本和日志，仍受64 KiB节点工件上限约束；超限明确失败，不截断证据。

### Git 边界与恢复

- 当前只支持 SHA-1、本地路径 bare remote、无真实 hook、无签名要求的受管仓库；HTTP/SSH/凭据和 GitHub PR 未接入。Git参数固定且不调用shell。
- 目标分支不能在任何 worktree 中被检出。commit 使用精确已验证 tree；update-ref核对旧SHA。push 使用精确 ref/commit 和远端旧SHA lease，并检查 fast-forward，不能覆盖分叉历史。
- 效果先进入控制账，再取得一次发送资格。开始前已落账的stop/补充/撤权阻断发送；已开始动作的迟到结果仍入账，不承诺撤回在途操作。
- 回执丢失保持 unknown 和资源占用。先 `runtime.delivery.reconcile(effectId)` 独立读回本地/远端事实；确认 succeeded/failed 后才能 `controller.recover(...)`。对账不产生 commit/push。远端又前进、条件冲突或无法证明结果时保持 unknown，不自动解锁重试。
- 任务状态和节点进度由控制账产生，无需执行 Agent 额外回复进度；本批尚未接入旧 Web 看板/钉钉展示。

## 8. M2 受管代际目录

新增 `createManagedWorkspaces({root,sourceRepository})` 导出。root 是预先创建的专用绝对目录，必须位于源仓库之外；sourceRepository 是固定本地源。准备方法只读，目录路径由 runId/generation 摘要生成，业务消息不能指定任意写入路径。

在已有 `executionDelivery` 服务对象中添加 `workspaceAdapter`，仍使用同一个真实任务授权回调；直接 openExecutionRuntime 则放在 deliveryOptions 中。不得另行重复 provide 已存在服务。

```js
const workspaceAdapter = await createManagedWorkspaces({
  root: '<既有的受管根目录绝对路径>',
  sourceRepository: '<固定源仓库绝对路径>',
})
// 作为受信code节点的execute；节点声明allowedEffects:['workspace.prepare']。
async function prepareDirectory({ input, runId, generation, requirementDigest, perform }) {
  const prepared = await workspaceAdapter.prepare({
    runId, generation, requirementDigest, baseCommit: input.baseCommit,
  })
  return perform({ action: 'workspace', prepared })
}
```

`perform` 返回适配器业务产出，例如 `{status:'succeeded',directory,baseCommit,baseTree,preparedDigest}`，不会把控制账的回执信封当业务参数。权威效果记录和证据仍通过 store 查询。Agent不能声明 workspace.prepare 能力，原始execute/reconcile仅供受信Host内部，不是模型工具。

流程固定为：控制账身份/授权/屏障检查 → 持久效果开始 → 独占创建父容器及归属文件 → 独立无hardlink clone → detached checkout固定base → 对照完整文件全集和每个blob SHA → 写初始化完成标记 → 控制账观察回执。源未提交修改和旧代目录从不复制；源HEAD/index/工作文件保全。一个代际一次分配，不提供覆盖、reset、重新克隆或自动删除入口。

新补充先在Controller持久接纳并排空旧执行，再建立新代目录。A代删除/未跟踪内容不进入B代；A目录保留以便核对。保留旧改动需要后续明确采纳和重新验证，本批不自动合并。

结果丢失时沿用第7节 `delivery.reconcile(effectId)` 后恢复：完整归属、完成标记及固定HEAD仍相符才能复用；之后用户对文件的正常编辑保留。目录不存在、初始化残缺、归属或HEAD冲突时不覆盖，保持恢复错误/unknown供定位。已记录创建成功的目录再次使用前也重新检查当前身份，旧receipt不是当前目录存在的证明。

准入限制：SHA-1独立非bare源仓库；不支持源worktree共享对象、`.gitattributes`、链接、子模块、shallow、alternates/grafts、hook和执行型Git配置。初始化Git使用独立global/system配置边界；不运行项目脚本。文件上限与候选一致（单文件16MiB、合计64MiB、10000项）。独立仓库和元信息不构成OS权限/网络沙箱，不能因此开放任意shell。

## 9. 消息工作流按群离线切换

切换工具为 `scripts/cutover-message-workflow.mjs`，不是在线迁移。运行器已在旧群入口注册和每次处理前调用 `workflow-cutover.js` 的 `readWorkflowSeal({ sealPath, conversationId })`；返回 `blockLegacy: true` 时禁止旧引擎处理该群。`sealed` 已经禁止旧入口，不能等 `active` 才禁止。文件损坏、快照校验失败应阻止服务启动，不能退化为“未配置”。只有部署包含此检查的新二进制才可使用该封存协议，旧二进制不理解 seal，禁止再次可写启动。

1. 先在当前运行时逐项核对所选群的活动 Task、入站未结记录、话题决策、协调请求、任务保留、人工请求、Outbox 与待通知。未结记录必须按原业务入口处理并独立读回；工具不会删除、置成功或 supersede 它们。
2. 记录 Runtime 真实 PID、端口与启动该实例的计划任务准确名称。禁用自动启动，按前面的停机规范停止实例；再次确认 PID 不存在、端口不监听、计划任务不存在或已 Disabled。不要只检查 HTTP 请求失败。
3. 使用实际 DSH_HOME 路径显式传参；以下均是占位符，不能直接照抄。`--runtime-pid` 是刚才已停止的真实 PID，不是任意不存在的 PID。计划任务准确名称不存在时，探测结果会记 `scheduledTaskPresent:false`；仍须由操作者确认没有其它自启入口。

```powershell
$legacyFile = '<DSH_HOME>/storages/dingtalk-dsh-assistant/dingtalk_dsh_assistant.json'
$cutoverJournal = '<旧JSON同目录>/dingtalk_dsh_assistant.workflow-seal.json'
$controlDb = '<本实例执行数据目录>/control.sqlite'
$artifactDirectory = '<本实例执行数据目录>/artifacts'
$instanceId = '<固定实例ID>'
$groupId = '<指定群ID>'
$stoppedRuntimePid = '<刚停止的真实PID>'
$runtimePort = '<Runtime端口>'
$scheduledTaskName = '<准确计划任务名称>'

node scripts/cutover-message-workflow.mjs --legacy $legacyFile --journal $cutoverJournal --db $controlDb --artifacts $artifactDirectory --instance $instanceId --group $groupId --runtime-pid $stoppedRuntimePid --runtime-port $runtimePort --scheduled-task $scheduledTaskName --check
```

`--check` 零写入：只读旧 JSON、已有控制库身份、现有 journal 与 Windows 进程/监听/计划任务。返回 `CHECK_PASS` 只表示本次离线门禁通过，不代表模型、渠道或新链路业务验收。出现 `CUTOVER_LEGACY_NOT_DRAINED`，按 `details.issues` 中的原始 ID 对账；不得为部署而清空队列。已有库缺消息 schema 返回 `CUTOVER_OFFLINE_SCHEMA_UPGRADE_REQUIRED`，不得在线补表或覆盖原库。

4. 自检通过且目标未改变，再将上述末尾的 `--check` 替换成 `--execute`。工具再次探测停机、校验旧文件摘要，保存不可变 `dingtalk_dsh_assistant.workflow-seal.json.legacy-snapshot.json`，先持久写单一 journal 的 `sealed` 阶段，再显式初始化新控制库/工件目录并调用同库 `message.group.begin` 与 `message.group.activate`，最后独立回读群状态后将 journal 更新为 `active`。旧 JSON 内容不变。
5. 运行器从 storageDomain 的 JSON backend.root 自动定位固定相邻 seal，无需可被误删的 seal 路径配置；安装、启动新实例，回读 seal 摘要、控制库 instanceId、group engine/epoch、实际包文件摘要及新 PID，然后分别验收消息接收、S/R/I、Task 首节点活动、任务状态与通知事实。不能用 `ACTIVATED` 代替这些业务证据。

### 中断恢复与边界

工具在 snapshot 落盘后、journal sealed 后、控制库初始化后、group begin 后任意中断，应保留全部现场，用同一参数重新执行 `--check` 和 `--execute`。命令 ID 由 journalId 和 groupId 固定派生；已接管群只读核验，不递增第二次 epoch。新建数据库后工件目录创建中断也可恢复，不删除数据库重来。

seal 是新旧入口的共同协议，JSON 与 SQLite 不是跨库原子事务。安全前提是停机窗口内已禁用所有自启入口，且恢复启动使用遵守 seal 的版本。工具不声称可以阻止操作者手动启动不认识 seal 的历史程序。PID/端口/计划任务检查是当前 OS 观测，不能证明任意未知自启机制不存在。

journal 已 sealed 后不得直接删 journal 或恢复旧快照来“回滚”。控制库未接管时可以前向重试；接管后产生的新消息、审批和效果必须保留。`message.group.abort` 只停止未完成的控制库切换并保留 buffered 消息，不构成恢复旧引擎业务写入的充分证据。旧入口放开必须另行完成无新事实/无效果的对账和显式交接；本工具不提供绕过动作。

同源编辑验收：本地测试覆盖同文版本复用、否定编辑取消原任务、运行中修订同一任务输入代际，以及执行前取消/暂停修订。编辑未能关联原任务时保留澄清与源屏障，不视为完成。切换仍要求旧账 Outbox、协调、任务等实际排空；测试通过不能替代现场对账。

### 工程仓库准入与固定检查

`workflow.repositories` 必须来自实际仓库核验。源目录需要独立 `.git` 目录、无非 sample hook、无受禁止的 Git 配置/替代对象源、无 `.gitattributes`；带用户 hook 的主仓不得删除 hook 来过门禁。可由部署操作者在独立目录 `git init --template=` 后，仅 fetch 已核对的 commit，建立固定 `refs/remotes/origin/main` 并 detached checkout；不要复制主仓 `.git` 或未提交修改。更新基线必须另行核验 commit、检查配置和版本，不能让模型自行更新源目录。

本机 `D:/project/jimu_dataset_web` 的 origin 为 `https://github.com/HiQ-AI/dataset-web.git`，有有效 hooks，不能直接准入；其基线源码可在独立 source checkout 中验证。项目真实脚本为 `build`、`build:test`、`lint`，没有 `test`。检查任务在冻结候选的独立目录执行，依赖不会继承主仓。固定 `checks.steps` 应含冻结 lockfile 的依赖安装和真实构建；Windows `shell:false` 下使用 Node 可执行文件与 Yarn CLI JS 的绝对路径，不能直接把 `.ps1/.cmd` 作为 executable。必须先在隔离候选目录实跑成功，再写入正式 profile，不能用空 repositories 或仅语法检查宣称工程链已准入。
## 工程确定失败与代际续接

固定工程检查失败会显示 `ENGINEERING_VERIFICATION_FAILED`，不由5秒恢复定时器反复运行；新增需求仍通过同一Task输入代际重新验证。已推送后补充需求从上一交付SHA创建新代目录，精确核对远端未漂移后快进同一任务分支、更新同一OPEN PR。旧PR关闭或身份不符不另建PR绕过。

检查节点取消/超时须等待前台进程树退出。Host异常退出后的未排空外部检查保留 `EXECUTOR_DRAIN_EVIDENCE_REQUIRED` 屏障；SQLite独占锁不是旧子进程退出证明，禁止手改drained放行。

Web 操作验收需使用配置明确映射的 `workflow.webActorId`。新任务取消/补充走同库 Web 事件与 Controller，不依赖旧 Topic；验证重复 requestId、跨站 Origin、伪造 actor、陈旧版本及暂停补充反例。归档/改名/重开尚未实现，返回明确冲突，不转发旧引擎。持久 Web 事件准备后中断由服务恢复接纳；输入接纳前后不得改写 Task 执行基线字段。

## 10. 话题批量意图与业务 Task 计划升级

原业务 Task 计划引入 schema v2；当前 Task 负责会话要求 schema v3。服务启动不会自动升级旧库。停掉持有控制库的 Runtime、入站桥接和计划任务后，确认对应进程及 `.owner.sqlite` 写者已经退出，保留控制库与工件目录原始备份，再用绝对路径执行零写自检：

```powershell
$controlDb = '<本实例执行数据目录的 control.sqlite 绝对路径>'
node scripts/migrate-execution-task-plan.js --check $controlDb
```

仅来源库为 v1 时执行上述 v1→v2 步骤；已经是 v2 的实例从下面 v2→v3 自检开始。核对输出 `fromVersion`、`toVersion:2`、`executionRuns` 与目标路径。自检不写数据库；确认路径和备份后才执行：

```powershell
node scripts/migrate-execution-task-plan.js --execute $controlDb
node scripts/migrate-execution-task-plan.js --check $controlDb
```

执行时脚本先生成带 `pre-task-plan-v2` 后缀的 SQLite 备份，再在原控制库事务中建业务 Task/阶段表；最终回读 `schemaReadback:2`。保留脚本输出的 `backupPath`，不要直接删除活动 WAL 文件。旧单 Run 历史不会被推断为多阶段或已确认 UAT；需要续办时仅对已经成功且证据齐全的旧 workflow-v2 Run 显式建立计划。旧 JSON Task 不自动迁入新账。

确认控制库实际为 v2 后，继续对 v3 执行零写检查。`--check` 只读并输出 `writes:0` 与 Task、阶段、Run、效果、审批和消息账的行数及 SHA256 摘要；旧库在该步骤不迁移既有 Task 为负责人会话，已有计划保留原运行历史，新建 Task 使用新机制。执行模式先用 SQLite `VACUUM INTO` 保存唯一的 `pre-task-owner-v3` 备份，逐表核对备份摘要，再在事务中增加任务级控制、负责会话事件/验收/报告账，回读 `schemaReadback:3` 并再次核对原表摘要。保留输出中的备份路径：

```powershell
node scripts/migrate-task-owner-store.mjs --check $controlDb
node scripts/migrate-task-owner-store.mjs --execute $controlDb
```

若检查输出有未确认外部效果或待审批记录，先逐项核对；迁移不会把它们视为已成功。v3 启动后先回读 `PRAGMA user_version`、`execution_meta.schema_version`、Task 数量与备份，定向验证同一 Task 的会话恢复、补充意图、暂停取消、后续阶段与最终报告，再开放群入站。只读 `--check` 针对 v2，成功迁移后再调用会因来源版本不符而拒绝，不能用其代替 v3 回读。

默认日常流程只读已授权话题来源及本任务前序产物，并可按当前原文生成可回读的 Markdown 摘录。Resident 可由受信插件提供 `dingtalkTaskGeneralCapabilities` 数组；每项需有固定 `id/identity/description` 及 `authorize/execute/verify`，其中 `verify` 必须回读结果并返回 `passed:true`、实际 `outputDigest` 和非空 `sourceRefs`。对非默认纯原文整理目标，还须同时提供 `dingtalkTaskGeneralCompletionCheck` 与 `dingtalkTaskGeneralCompletionIdentity`，验收器逐项核对 acceptanceCriteria 与证据后返回 `status:'satisfied'`、`resultVerified:true` 和相同顺序的 `criteria`。未配齐时流程显示证据不足，不把读取聊天误当作数据库调查或外部处理。

升级后先禁用群入站、启动新 Runtime 并回读控制库版本及实例身份；用隔离消息验证 R 归类屏障、同话题 IB 集合、新消息重判、Task 阶段结算、确认后单次启动和缺适配器阻塞，再开放入站。恢复扫描会结算已成功的阶段 Run 并启动满足条件的后继；`waiting_confirmation` 不自动越过。已执行效果仍应按原 Run/效果账独立核对，控制库迁移成功不代表模型判断、UAT 提测或渠道送达成功。

### 工程固定检查的阶段预算与失败证据

`checks[].timeoutMs` 是整个检查的总执行预算，默认仍为 `120000`，允许范围 `1..2400000` 毫秒。每个 `steps[]` 可显式配置 `timeoutMs`，范围 `1..1800000`；省略时沿用共享总预算语义。实际单步 deadline 取自身预算与总剩余时间的较小值，不在下一步重置总时间。参数只能由 Host 配置提供，不由消息或模型延长。

冷安装与构建各需独立预算的仓库，可明确写为：

```js
{
  id: 'install-build', version: '1', timeoutMs: 2400000,
  steps: [
    { executable: trustedNodePath, args: [trustedYarnCliPath, 'install', '--frozen-lockfile'], timeoutMs: 600000 },
    { executable: trustedNodePath, args: [trustedYarnCliPath, 'build'], timeoutMs: 1800000 },
  ],
}
```

示例不代表该仓库已经构建通过。必须用真实冻结候选完整实跑 PASS 后准入；不自动增加预算，不忽略超时或退出码。每步日志记录 `startedAt/elapsedMs/budgetMs/timeoutScope`，`timeoutScope` 为 `step`、`check` 或未超时的 `null`；elapsed 包括终止排空时间，可能略超过 deadline。总预算从开始执行检查步骤计时，保留原来不含候选物化时间的语义。

失败工程检查保持 `waiting/ENGINEERING_VERIFICATION_FAILED`，不发放交付资格。检查日志以最多 128 个内容地址工件保存到失败节点 `evidenceRefs`：每个日志按 16KiB 原始 UTF-8 字节分块、base64 编码，附检查 ID/版本/结果、part/parts、字节总数和日志 SHA256；重组按同一检查的 part 顺序拼接字节，再校验 SHA 并解码 UTF-8。每工件仍受 64KiB 上限约束。没有把日志丢在仅本轮可见的内存错误里，也不把失败节点标记成功。

检查 job 日志只在 `steps[]` 保存 stdout/stderr，顶层只保留退出/超时摘要。各流带 `stdoutEncoding/stderrEncoding`：有效 UTF-8 普通文本在其 JSON 编码不长于 base64 时使用 `utf8`，其余输出使用 `base64`；读取时按该字段解码。32KiB 限制按所有步骤合计的原始输出字节计量，不按 base64 长度计量。固定命令与root的JSON配置共同受8KB上限约束，避免大配置挤掉64KiB结果的日志空间。没有静默删去已采集字节。

业务工程检查的 Node 版本与 DSH Host 分开固定：本机 DSH 使用 Node 24；上述 dataset-web 基线 `.nvmrc/.node-version` 为 Node 20，生产 Dockerfile 的依赖与构建阶段为 Node 22，因此本地生产构建验证采用已安装的 `D:/soft/node-v22.13.0/node.exe`。不能因为 Host 要求 Node 24 就让业务工程自动使用 Node 24。Yarn CLI 也固定绝对路径和实际版本；需独立回读实际 Vue 构建子进程的 Node 路径，而不只核对启动脚本。

## 11. 原任务流程目录与外部效果准入

新消息入口按发布版目录仅暴露通用材料分析、五类已给材料只读审查及已配置仓库的工程流程。材料审查无仓库/数据库工具，不能回报“已查询 PR、已导出文件”。UAT 交付、生产发布、同提交重构建、数据变更只有源码中的固定节点合同；当前本机配置无对应受信 Host 适配器，入口仍拒绝这些执行类型。运行中历史旧 Task 不按新定义重放。

受控外部效果只允许 code 节点声明 `external.operation`。受信适配器须提供当前只读快照、精确准备对象、发送和独立回读；prepared 必须绑定 run/generation/requirementDigest、workflowKind、目标资源键和平台操作身份。网关在同一控制账检查停止、输入修订、撤权、资源占用及批准，再发放一次发送资格。生产批准绑定一个精确 effect 请求；Web 或钉钉认证入口的首个有效终态由控制账记录，尚未接入两端审批 UI 与真实通知前，不得打开生产准入。unknown 效果只读对账，不重试发送。

隔离验证可运行 `node --test test/task-readonly-workflows.test.js test/task-release-workflows.test.js test/workflow-data-change.test.js test/execution-external-delivery.test.js test/workflow-service.test.js`。合成适配器通过仅证明编排合同，不证明 Woodpecker、Bytebase、Registry、Kubernetes、真实数据库或渠道投递。完整迁移状态见[第 27 轮](../acceptance/runtime-redesign/round-27.md)。
