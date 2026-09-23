# 实验性执行底座本地运维

本说明对应 M1 的独立执行入口 `@zzusp/dingtalk-dsh-assistant/execution`。它**不默认加载**，不读取或迁移 resident 的 Task 账；现有群消息、Web 看板和 resident 流程继续使用原入口。当前仅准入受信定义的 `pure/read` 顺序节点，用于隔离环境中的合成任务与受控读取。

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
| 工作流 | 最多 32 个顺序节点，仅 code/agent，效果声明限 pure/read |
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

包的 `./execution` 入口导出 `freezeCandidate`、`readCandidate`、`verifyCandidate` 和 `createGitDelivery`。M2 已提供第 8 节的受管代际目录；跨代自动清理、GitHub PR 适配器、真实项目 shell 检查、消息通知及完整开发业务准入仍未完成。

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
