# 任务产物文件发送到群聊

日期：2026-09-28。性质：实施前设计，不代表功能已实现或真实群聊验收通过。

检查基线：当前仓库 `main`，提交 `64e161f75b612a013581a57cd6c7389d6e20354f`；本机 DWS `v1.0.61`。本轮未改业务代码、运行配置和数据库，未向钉钉发送消息或文件。

## 1. 结论与可验证目标

当前仓库没有接通“任务产物文件 → 群聊文件消息 → 文件送达核验 → 任务交付完成”的路径。DWS 已提供本地文件发送能力，缺口在插件接入、文件产物合同和任务完成判据。

目标用例：用户在群里要求“处理完把报告、Markdown、SQL 脚本和图片发到本群”，系统完成业务处理后，发送可下载的原文件，逐件记录真实消息和文件核验证据；所有必交文件通过核验，才允许任务完成。单纯生成文件、上传成功或发送受理，都不算完成该交付要求。

此结论针对上述仓库基线和本机 CLI；本轮没有核对当前运行实例的安装包，也没有断言所有格式在当前租户都已发送成功。

## 2. 当前实现与反证检查

| 检查点 | 当前事实与证据 | 对方案的影响 |
|---|---|---|
| 群聊发送 | `packages/dingtalk-dsh-assistant/dws-adapter.js:62` 的 `compileGroupSend` 固定 `--text`；`:67` 的引用回复固定 `--content` | 增加受信文件发送入口 |
| 任务通知 | `workflow-notifications.js:26` 只传 `groupId/text/idempotencyKey`；`:90` 固化文字；`:123` 从 Owner 报告生成完成摘要 | 通知中没有结构化文件交付 |
| 老路径 | `dws-adapter.js:298` 的 `dispatchOutbox` 也只发送文本/文本引用回复 | 不是新入口漏用一个已有文件出口 |
| 送达核验 | `resident.js:160` 起查询发送状态，再读取消息；`:175` 比对正文 | 文本匹配不能核验文件 |
| 本地文件 | `task-markdown-file.js:13` 已有受信 Markdown 写入；`:21` 限制 12000 字节；`:49` 固定哈希名称 `.md` | 可复用安全落盘思路，但不是任意文件导出器 |
| 内部工件 | `execution-artifacts.js:34` 只接受内容寻址 `.json`，`:42` 保存 JSON | 不能把工件 JSON 当用户要求的 `.docx/.sql/.png` 发出 |
| 入站附件 | `dws-adapter.js:193`、`:218` 能读资源/加载图片 | 这是收件能力，不是出件能力 |
| 执行门禁 | `execution-controller.js:60`、`:230` 未接纳消息发送效果；`execution-delivery.js:21` 没有 message adapter | 需要作为正式外部效果接入 |
| 工作目录 | `resident.js:124` 用 `tmpdir()` 创建 DWS runner；`dws-runner.js:16` 固定进程 cwd | 不能把任意工作树绝对路径直接传给 CLI |
| 文件传输基础 | 实跑 `dws chat +messages-send --help`、`dws schema --cli-path 'chat +messages-send' --compact --format json`，显示 user 可用 `--msg-type file --file` | 复用 DWS，不新建钉钉 HTTP 客户端 |

额外只读探针实跑得到三条断言：仅传文件会触发 `text_required`；文本调用携带 `filePath` 不会生成 `--file`；通知携带 `attachments` 不会把它传入 adapter。探针全部使用内存对象，未调用 DWS。

相关现有测试 `node --test --test-reporter=dot test/dws-adapter.test.js test/task-general-workflow.test.js` 通过，共 29 项。它们是当前行为基线，不是新增文件交付验收。

## 3. 方案选择

| 候选 | 优点 | 判断 |
|---|---|---|
| Agent 直接执行 DWS 命令 | 接入很短 | 不采用：绕过任务效果账、文件披露范围及未知结果恢复 |
| 完成通知增加 attachments，Task 仍先完成 | 可复用现有通知轮询 | 不采用：必交文件失败时 Task 已完成；“事后通知”无法独立表达必需交付阶段 |
| 显式文件交付阶段，复用 Execution Delivery 和 DWS | 文件、目标、外部效果与完成条件可以独立核验 | 推荐 |

推荐新增固定流程 `task-group-file-delivery`，作为已有业务 Task 的一个阶段，不创建第二个业务 Task。底层文件发送以 `message.send` 效果经过 Execution Delivery。文字完成通知继续使用既有通知账；同一文件只由效果账驱动一次发送，不能同时交给 notification worker 发送。

## 4. 用户行为与格式范围

用户说“处理完发到本群”已经提供该任务结果向本群交付的意图，不逐文件重复询问。Host 仍核验真实来源、操作者权限、当前群配置及 DWS 写授权；宽泛的 `writesAuthorized=true` 不能单独授权任意本地文件外发。

默认目标绑定任务来源群。发送到另一群、改用另一账号或扩大发送材料，需要相应明确授权；不能由模型任意替换目标。Web-only 任务继续禁止自动向钉钉外发。

| 产物 | 首版交付方式 | 边界 |
|---|---|---|
| `.md/.txt/.sql/.csv/.json` | 原文件附件，保留真实扩展名及字节 | `.md` 文件和聊天 Markdown 正文是两种产物；SQL 交付不代表执行 SQL |
| `.docx/.xlsx/.pptx/.pdf` | 已生成且验证过的原文件附件 | 不能把文本改扩展名伪造 Office/PDF；生成器缺失时明确受阻 |
| `.png/.jpg/.webp` 等图片 | 原图文件附件，可下载 | 首版不承诺聊天气泡内预览 |

文件发送能力不替代文件生成能力。首版闭环包括：接入已有 Markdown 产物，受信导出文本/SQL，以及登记已有受信工具生成的二进制产物。要求现场生成 Word/PDF/图片时，必须有对应生成器和独立文件验证，否则不能声称该格式任务已经可执行。

图片预览后续作为明确的交付模式接入：当前 CLI 的 image 入口需要已有 `mediaId`，本地 `--file` 描述只覆盖 file/audio/video。未验证图片上传与回读合同前，不假设 `--msg-type image --file` 可用，也不静默把“发预览图”当成“发附件”完成。

一条简短引用回复说明交付文件清单；每个文件一条独立文件消息；全部核验后再发完成摘要。文字和文件不是一次原子发送，CLI 的 `--text/--markdown/--file` 互斥。文件消息首版不承诺原生引用回复，引用关系由摘要和内部 task/source 绑定保留。

## 5. 产物与授权合同

在需求规范化时保存结构化交付要求，Host 将模型提取的候选与真实请求对应。字段为拟议合同，尚未存在：

```json
{
  "deliveryRequirement": {
    "channel": "dingtalk-group",
    "target": "source-conversation",
    "required": true,
    "items": [
      { "role": "report", "format": "md", "required": true },
      { "role": "migration-script", "format": "sql", "required": true }
    ],
    "authorizationSourceRefs": ["<真实来源引用>"]
  }
}
```

不是所有任务默认发附件；只对明确要求文件交付的任务建立该合同。验收必须逐项覆盖需求，不能“模型只列出一个已生成文件 → 发送清单全绿 → 漏掉其他必交文件”。不由扩展名/一句摘要猜测完成条件。

产物完成后，由 Host 登记不可变 manifest，使用既有 JSON 工件库保存元数据：

```json
{
  "taskId": "<Task>",
  "requirementRevision": 3,
  "producer": { "runId": "<Run>", "nodeRunId": "<Node>", "outputRef": "<已验收产物>" },
  "files": [{
    "artifactId": "<Host 分配>",
    "role": "report",
    "fileRef": "<受管文件引用>",
    "fileName": "处理报告.md",
    "mediaType": "text/markdown",
    "size": 1234,
    "sha256": "<实际文件字节摘要>"
  }]
}
```

模型只能选择本任务当前已验收的 artifactId。Host 解析实际路径、群 ID、profile 和授权来源，不能接受模型任意 `C:\\...`、URL 或其他任务文件作为发送输入。

文件快照存放在现有 `taskOutputDirectory` 下的任务/交付专属目录；manifest 放在 `artifactDirectory`。复用原子发布和内容校验方式，二进制不塞进 JSON/base64。文件名保留可读名称，目录隔离同名文件；拒绝路径分隔符、控制字符、Windows 保留名及路径穿越。

首次登记复制实际字节并计算大小、摘要，独立读回；已登记内容不可修改。源文件来自受信生产者输出或明确授权的材料，不扫描整个工作区自动打包。读取、快照和发送前检查真实路径、普通文件、链接/junction 逃逸及文件身份变化；快照目录仅供受信进程写入。原始工作树归档或文件后续变化不会改变已冻结版本。

全部文件先预检，发现不存在、格式无效、缺授权、大小/数量超配置限制即停止，不先发送半包。大小、总量、数量使用显式配置限制；钉钉当前租户上限尚未实测，不能把建议配置称为平台上限。

## 6. 执行与回读

```mermaid
flowchart LR
  A[业务阶段产出文件] --> B[登记并核验不可变清单]
  B --> C[文件交付阶段]
  C --> D[Delivery 逐件领取效果]
  D --> E[DWS 发送文件]
  E --> F[保存受理回执]
  F --> G[查询真实消息并核验资源]
  G --> H[所有必交文件通过]
  H --> I[Owner 核验任务完成]
  I --> J[既有通知发送完成摘要]
```

固定阶段包含准备交付、逐件交付、汇总核验三个 code 节点；文件数由清单控制，不按文件动态生成 Workflow 定义。`prepare-delivery` 核对当前需求、清单及来源；快照应已由生产/登记环节生成，不能在标成 read 的节点偷偷写文件。

逐件交付走 `perform({ action: 'message', prepared })`；每件一个外部效果。当前 effectId 只由 `nodeRunId + action` 派生（`execution-delivery.js:107`），不能直接循环复用。为 message action 增加受信清单项身份，绑定清单摘要、artifactId、字节摘要、目标、profile 及需求版本；模型不能自由提供该身份。

另存业务 deliveryKey 关联恢复前后的同一交付项。恢复不能换 nodeRunId、generation 或随机幂等键就绕过去重；先核对原效果，再接纳已有送达证据。用户明确要求重发，才创建新的交付请求并关联前次记录。效果资源范围应绑定交付项，未知文件不应长期锁住整个群的所有通知。

文件 sender 使用独立 runner，cwd 指向受信交付快照目录，传相对文件名；不调用全局 `process.chdir()`，不改变监听/文本通知的 runner。复用现有 `runTimeoutMs` 构造参数设置文件上传超时。

拟调用的已存在命令形态如下，ID 均由 Host 绑定；只在本次发送已获授权时附加 `--yes`：

```powershell
dws chat +messages-send --as user --group '<真实群ID>' --msg-type file --file './处理报告.md' --idempotency-key '<持久交付项ID>' --profile '<绑定profile>' --format json
```

发送与核验分开：

1. `effect.prepare/begin` 持久领取后，执行一次发送。
2. 收到 ACK 立即持久化 `openTaskId`、CLI 返回的真实资源身份及原始回执引用；未取得送达证据时记 unknown/pending-readback，不能先记 succeeded。复用 `effect.observe` 的 unknown 观测保存回执，不误用仅支持 OS job 的 `effect.identity`。
3. 通过发送状态拿到真实 messageId/conversationId，再用消息详情精确回读。`openTaskId` 不是 messageId。message adapter 的 reconcile 需要获得已持久回执；当前 Delivery 只传 prepared，接入时须明确补足该参数，不能只在内存保存 ACK。
4. 核对目标群、绑定发送身份、消息类型与资源关联。文件名相同不构成同一文件。以真实返回的资源 ID 绑定发送与查询结果；缺少该合同的字段不猜测。
5. 原文件模式下载实际消息资源，对照快照的大小和 SHA-256；首版以此作为文件内容验收。现有 `readMessageResource` 是受限文本读取，需增加保留原始字节的下载/校验入口，不能用文本摘要核验二进制文件。
6. 写入每件消息 ID、资源引用、字节核验及时间；全部必交项成功才生成阶段交付报告。渠道已看到消息但下载校验失败时，展示“消息已观察到，文件待核验”，不能冒充内容已验证。

当前 CLI compact schema 没有给出稳定文件发送结果结构，并把整体 idempotency 标为 unknown。实施前必须用授权测试群确认上传回执、资源引用、下载结果和重启窗口，不能仅凭存在 `--idempotency-key` 就宣称端到端 exactly-once。

## 7. 失败、恢复与完成门禁

| 情况 | 处理 |
|---|---|
| 文件生成失败 | 停在生产阶段；不生成文件交付成功记录 |
| 发送前明确无副作用的预检失败 | 保存原因，修复后仍发送原快照 |
| 已受理，回读尚未完成 | 保留 ACK，仅轮询查询/下载，不再次发送 |
| 发送超时/进程退出/回执丢失 | 标记 unknown；只对账，无法确定时保持待核对 |
| 多文件部分成功 | 保留逐件结果，后续不重发已送达文件；遇未知项暂停本批后续发送 |
| 回读字段不足或内容不匹配 | 不完成；保留真实消息及差异，不能按名称认领另一个文件 |
| 取消、暂停、群撤销、需求变更 | 每件发送前重新检查，阻止后续效果；已发文件仍保存审计，不擅自撤回 |
| 用户修改已冻结交付内容 | 新版本、新清单；旧未知效果先对账，不重做旧业务处理 |

未知发送遵循现有 `DELIVERY_RECONCILIATION_REQUIRED` 等待恢复边界。为该阶段补确定性的恢复器：只读对账并保存观测，满足现有恢复准入后唤醒原节点；成功项复用回执、未领取项继续执行。不得让 Owner 通过重建一套阶段自动重发。

如果发送被远端明确拒绝，只有证据证明没有形成文件消息且原因可重试，才可在受信恢复策略下产生关联前次的重试尝试。普通非零退出码不足以证明未发送。完全丢失 ACK 且无法唯一关联时保留待核对，不用“同名文件搜索”猜测补账。

`authorizeCompletion` 必须增加跨阶段检查：当前需求要求交付文件时，即便前面的业务/写文件阶段均成功，也必须存在匹配当前 requirementRevision 的交付阶段和完整清单验收。不要只在交付流程自己的 ownerContract 里检查，否则 Owner 省略这个阶段就能绕过。

业务处理完成、文件逐件送达、完成摘要送达分别记录。摘要发送失败不会重发文件；必交文件未核验时不能生成“任务已完成”报告。状态展示至少覆盖“文件已生成 / 正在交付 1/3 / 部分送达 / 结果待核对 / 全部送达”。

新增文件消息的真实 ID 必须进入统一出站查询及回声隔离：当前 `message-ledger.js:930` 的 outbound 查询仅查询 notification。新增效果读取投影，关联 Task/topic/source，复用原有回声竞态处理；不能让自己刚发出的文件又创建一个新任务。引用该文件的后续用户消息也应能定位原任务。此投影不再拥有发送权。

## 8. 实施落点

| 文件/模块 | 必要调整 |
|---|---|
| `workflow-service.js`、需求/目录定义 | 提取并保存 deliveryRequirement，注入 sender，登记流程，准备初始及后续阶段输入，最终完成门禁 |
| `task-owner-session.js`、`task-workflow-contracts.js` | Owner 能识别必交文件阶段，读取真实清单/证据；缺阶段不能完成 |
| 新 `task-artifact-files.js` | 任务文件登记、不可变快照、元数据与字节验证；新建理由：现有 Markdown adapter 的文字/12 KB/固定扩展名合同不能承载二进制 |
| 新 `task-group-file-delivery.js` | 三个固定节点与领域 ownerContract；新建理由：复用流程底座，但文件交付有独立外部效果及完成合同 |
| `execution-controller.js`、`execution-delivery.js` | 接纳 code-only message.send、注入适配器、逐件身份、持久 ACK 及恢复核验；其余效果合同保持原义 |
| `dws-adapter.js`、`resident.js` | 文件命令、专属 cwd/超时、绑定 profile、结构化发送回执和原文件下载核验 |
| `message-ledger.js`、`workflow-service.js` | 从已验证 message 效果提供出站只读投影、回声隔离和引用关联 |
| Observer 现有任务详情与通知展示 | 展示文件名/类型/大小、逐件交付状态、目标群和核验证据；不暴露任意本地路径 |
| README、`docs/ops/` | 能力范围、配置、权限、保留策略、未知发送恢复，以及安装/维护/验收步骤 |

不新增独立数据库、上传服务或全局万能命令。文件元数据继续用 JSON 工件，发送继续用控制库效果账。若增加索引或持久字段，按当前运行库 schema 明确迁移并走维护流程，不在启动时静默改库。

快照至少保留到送达/核验/恢复结束，unknown 项禁止清理；结束后的保留期由部署配置明确。清理必须先 check，依据受管引用而不是目录名猜测所有权；任务工作树归档与交付快照清理分开。

## 9. 验收与落地顺序

先完成授权测试群的传输合同探测，再实现产物登记和发送适配器，随后接入 Task 阶段/完成门禁，最后验证重启、回声和 UI。不得先把未验证文件回执字段写死到生产流程。

| 验收组 | 必须覆盖 |
|---|---|
| 真实格式 | Markdown、SQL、DOCX/PDF、图片原文件；中文及含空格文件名；下载后字节一致 |
| 完整交付 | 单文件、多文件、缺少一个必交角色；生成完成不等于发送完成 |
| 产物来源 | 内部 JSON 不冒充文档；旧需求版本、他人任务、未验收文件被拒绝 |
| 授权负例 | 无发送要求、跨群/跨 profile、Web-only、权限撤销：零外发 |
| 路径与容量 | 绝对路径、`..`、链接/junction、文件在读取时变更、超容量；预检前零发送 |
| 故障恢复 | ACK 后重启、ACK 丢失、上传/查询超时、部分成功、内容核验失败；无盲重发 |
| 版本与并发 | 两个恢复器竞争、需求修改、取消时尚有文件未发、同名不同内容、用户明确再次发送 |
| 消息关联 | 文件回声早于读回、引用文件追加要求、文本摘要失败但文件已交付 |
| 回归 | 原文字/引用通知、Markdown 本地写入、已有 Delivery、任务完成门禁 |

实施时在 `docs/acceptance/task-group-file-delivery/` 建 matrix 与逐轮证据；上述是待执行验收项，本轮不填 PASS。

尚未收敛的渠道边界：当前租户各文件类型/大小上限、文件 ACK 与资源身份的准确结构、下载回读权限、图片预览上传路径、服务端幂等有效期。它们影响实现细节和发布能力声明，不改变“需要正式文件交付阶段”的结论。

## 10. 外部参考

- [DWS 官方 Chat 技能](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/skills/multi/dingtalk-chat/SKILL.md)：文件使用高级发送，资源下载使用真实消息引用。
- 本轮读取的本地 `dingtalk-chat` 技能及本机 v1.0.61 leaf Help/Schema 为参数核对依据；上游 main 可能高于本机版本，不能直接当安装版本合同。
