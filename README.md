![钉钉群聊中的 DeepSeek Harness 数字员工](docs/manual/images/dingtalk-dsh-digital-employee.png)

# DingTalk DSH Assistant

`dingtalk-dsh-assistant` 是一组运行在 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/DeepSeek-Harness) 中的钉钉数字员工插件。它把钉钉群聊直接接入 DSH，让 Agent 不再只是等待 `@` 后回答问题的机器人，而是一个能够理解完整群聊上下文、主动参与协作并持续推进任务的团队成员。

在 DSH 与 DWS 已完成安装和登录的前提下，插件安装与基础接入可在约三分钟内完成。接入后，每个常驻群绑定一个固定主 Session，持续理解群聊中的讨论、决策和任务状态；需要实际执行的工作则交给独立叶子 Session 与 Goal。多个叶子任务可以并行推进，因此数字员工既能参与讨论和编写方案，也能排查问题、执行工具，甚至完成代码与功能开发。

插件不是独立 Agent 平台，也不自行实现第二套 Session、Agent 或任务执行引擎。Agent 身份、工作规则与可用工具由配置的工作区及其 `AGENTS.md` 决定，插件本身不包含个人姓名或数字分身设定。

## 从群聊机器人到数字员工

常见的群聊机器人或 Agent 接入方式通常需要被 `@` 才会唤醒，只能获得当前消息附近的片段上下文，更适合问答、检索等单次工作。`dingtalk-dsh-assistant` 通过 DSH 原生 Session、subagent 与 Goal，把群聊协作变成可持续、可并行、可追踪的任务闭环。

| 能力 | 普通机器人 / Agent | DingTalk DSH 数字员工 |
| --- | --- | --- |
| 参与方式 | 被 `@` 后响应 | 常驻群聊，主动判断并参与 |
| 上下文 | 当前消息或片段上下文 | 持续维护完整群聊上下文 |
| 工作范围 | 问答、检索等单次任务 | 讨论、方案、排障、工具执行、功能开发 |
| 任务处理 | 一次处理一件事 | 多个独立叶子任务并行推进 |
| 持续执行 | 回复结束后停止 | 通过 Goal 持续执行、等待、恢复和完成 |
| 结果交付 | 返回一次性答案 | 回到原群引用回复，保留证据与任务状态 |

## 与 DSH 的关系

插件直接复用以下 DSH 机制：

- `Session`：每个群一个常驻主会话，每个 Task 一个独立叶子会话。
- `subagent`：主会话只协调，叶子会话独立执行任务。
- `Goal`：维持叶子任务的持续执行、恢复和完成状态。
- `systemPrompt.section`：向主会话注入群名称、群 ID、群职责与决策协议；向叶子会话注入任务流程和证据要求。
- Agent Registry 与原生 descriptor：在 DSH Web 中展示并打开常驻会话、叶子对话和轨迹。
- 默认模型、推理深度与权限 preset：由 DSH 原生服务保存和应用。
- storage domain：持久化群订阅、消息、Task、可靠投递、人工介入事项和告警。
- attachment service：将钉钉图片作为 DSH 原生多模态附件传入会话。

插件只补充钉钉渠道和群聊工作流特有的能力：DWS 订阅与补拉、消息去重排序、任务准入与关联、可靠 outbox、人工介入、任务看板和运行告警。

UAT 交付、生产发布、数据变更与 UAT 同提交重建采用显式目标白名单和受信平台端口。配置、审批、平台只读检查与执行后回读的要求见[本地受信平台接入说明](docs/ops/trusted-platform-workflows.md)；缺少任何必要能力时，流程目录保持不可发起。

```text
DWS 群消息
  → dingtalk-dsh-assistant
  → DSH resident 主 Session（判断、沟通、协调）
  → DSH leaf Session + Goal（独立执行）
  → 主 Session（组织结果）
  → outbox + DWS 回读确认
  → 原群引用回复并 @模型从任务历史选出的相关参与人
```

不依赖 Agent Studio，也不要再并行启动另一套会话或任务 Runtime。

## 包结构

- `packages/dingtalk-dsh-assistant`：核心业务插件。负责 DWS 接入、群与 Session 绑定、消息处理、Task 调度、阻塞时的人工介入、可靠回复和配置页面。
- 任务表格同步：可在插件设置中绑定钉钉在线电子表格的一个工作表，由 Resident 纯脚本每 3 分钟将全部未归档 Task 全量覆盖写入；同步不调用模型，状态与失败原因在设置页单独显示。
- `packages/dingtalk-dsh-observer`：DSH Web 展示扩展。提供群聊会话、任务看板、归档任务、人工介入和告警页面。
- `.dsh/profiles/resident`：resident Runtime 的参考 profile 与 Cordis patch。
- `.dsh/profiles/web`：Web contribution 的参考 profile。
- `docs/spec`：关键状态机和工作流设计说明。
- `test`：插件单元测试和 Runtime 契约测试。

## 环境要求

- Windows 11 与 PowerShell 7。
- Node.js 24 或更高版本。较低版本缺少 DSH Session JSONL 持久化所需的 zstd API。
- 已安装 DSH `0.1.2-rc.1`，并能正常启动 `dsh web`。Assistant、Observer 与 DSH 核心包必须保持该版本边界，不能混装 `0.1.1-rc.2` 依赖树。
- 已安装并配置所选模型对应的 DSH provider。只有使用 ChatGPT/Codex 订阅时才需要 `dsh-codex-connect`。
- 已安装并登录 DWS。只有启用真实钉钉订阅时才需要。

网络环境需要代理时，可在插件的 Agent 配置中填写代理地址，也可以在启动前设置 `HTTP_PROXY` / `HTTPS_PROXY`。

### Skill 文件路径

DSH 根据 Session 的 Agent 工作目录发现项目级 Skill，同时加载用户级 Skill。默认扫描顺序如下，靠前的同名 Skill 优先：

1. `<Agent工作区>\.dsh\skills\<skill-name>\SKILL.md`
2. `<Agent工作区>\.agents\skills\<skill-name>\SKILL.md`
3. profile 显式配置的 `customSkillDirs`
4. `%DSH_HOME%\skills\<skill-name>\SKILL.md`，`DSH_HOME` 默认是 `%USERPROFILE%\.dsh`
5. `%DSH_AGENTS_HOME%\skills\<skill-name>\SKILL.md`，`DSH_AGENTS_HOME` 默认是 `%USERPROFILE%\.agents`

给本机所有 DSH 项目共享的 Skill，推荐安装到 `%USERPROFILE%\.agents\skills`；只服务当前 Agent 工作区的 Skill，推荐安装到 `<Agent工作区>\.agents\skills`。DSH 不扫描 `%USERPROFILE%\.codex\skills`，仅安装在 Codex Skill 目录中的 `write-pr`、`dingtalk-*` 等 Skill 不会进入 resident 或叶子 Session。

复制时必须保留完整的 `<skill-name>` 目录，不能只复制 `SKILL.md`，因为 Skill 可能引用同目录下的 `references`、`scripts` 或其他资源。目录被发现只表示 Skill 已进入会话目录；模型仍会在任务命中触发条件后调用 `skill` 工具加载完整指令。验证是否真正加载时，应在 Session JSONL 中同时确认对应的 `tool/call` 和 `isError: false` 的 `tool/result`，不能只检查文件存在。

## 安装到 DSH

推荐让 Web、resident Runtime 和看板运行在同一个 DSH Web 进程中，避免两个进程同时写同一份 Session JSONL 和 storage domain。

正式版本发布后，使用 DSH 原生插件命令安装根发行包；它会把 Assistant Runtime、Observer 看板和对应 bundle patch 一并装入 `web` profile。生产或验收环境建议固定版本：

```powershell
dsh plugin --profile web add dingtalk-dsh-assistant@0.5.8
```

需要跟随 npm 最新版本时可省略 `@0.5.8`。安装完成后必须重启 `dsh web`，仅看到依赖安装成功不代表插件 Runtime 已加载。

版本历史见 [CHANGELOG](CHANGELOG.md)，发行资产见 [GitHub Releases](https://github.com/HiQ-AI/dingtalk-dsh-assistant/releases)。设置页会通过 GitHub Release 检查新版本；“设置 → 插件 → 钉钉个人助理”的“版本与更新”卡片显示版本状态，并提供手动检查与更新命令复制入口。检查失败会明确显示错误，不会误报为最新版本。升级使用：

```powershell
dsh plugin --profile web add @zzusp/dingtalk-dsh-assistant@latest @zzusp/dingtalk-dsh-observer@latest --save-exact
```

升级后重启 DSH Web，并依次确认：profile 中的包版本、`GET http://127.0.0.1:18998/health`、设置页/运行看板、真实群消息收发。四层证据不能互相替代。

若 DSH 官方默认上下文压缩在长 Session 中出现摘要范围过小、反复压缩仍无法回到阈值的问题，可选装收敛式替换插件；安装、provider 互斥、验证和回滚步骤见[安装手册的上下文压缩接入章节](docs/manual/install-and-configure-dsh-web.md#可选接入收敛式上下文压缩插件)。该插件不随本发行包自动安装。

以下源码安装方式只用于开发未发布代码；普通安装和升级不需要克隆仓库，也不需要手工添加两个内部包。

维护者发布新版本时，先将根包、assistant 和 observer 的版本号及 `CHANGELOG.md` 更新为同一版本并合并到 `main`，再推送对应的 `v<version>` Tag。GitHub Actions 会在 Node.js 24.19.0 下重新构建、测试和打包，使用 npm Trusted Publishing（OIDC）按 observer → assistant → 根发行包的顺序发布；三个包回读一致后才创建 GitHub Release。发布 job 绑定 GitHub Environment `NPM_PUBLISH`，不再使用长期 npm publish token。首次启用和故障恢复见 [npm 发布 Runbook](docs/ops/npm-release.md)。

### 源码开发安装

#### 1. 获取源码并验证

```powershell
git clone https://github.com/HiQ-AI/dingtalk-dsh-assistant.git
Set-Location .\dingtalk-dsh-assistant
pnpm install
pnpm test
```

#### 2. 将插件加入 DSH Web profile

在 `%USERPROFILE%\.dsh\profiles\web\package.json` 中加入两个本地依赖。路径应替换为仓库的真实绝对目录：

```json
{
  "dependencies": {
    "@zzusp/dingtalk-dsh-assistant": "file:D:/path/to/dingtalk-dsh-assistant/packages/dingtalk-dsh-assistant",
    "@zzusp/dingtalk-dsh-observer": "file:D:/path/to/dingtalk-dsh-assistant/packages/dingtalk-dsh-observer"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@zzusp/dingtalk-dsh-assistant",
        "@zzusp/dingtalk-dsh-observer"
      ]
    }
  }
}
```

保留 profile 中原有的 DSH 依赖和 bundle，不要用上面的片段覆盖完整文件。

若使用 ChatGPT/Codex 订阅，再把 `dsh-codex-connect` 同时加入 `dependencies` 和 `bundles`；使用其他模型来源时保留对应 provider，不需要安装 `dsh-codex-connect`。

#### 3. 装配 resident Runtime

把 [`.dsh/profiles/resident/cordis.patch.yml`](.dsh/profiles/resident/cordis.patch.yml) 中的 resident 配置按需合并到实际使用的 Web profile patch。Web 基础 bundle 已包含 storage 相关插件，只覆盖 `storage-json` 配置并插入 `dingtalk-dsh-assistant/resident`，不要重复插入同名 storage 项。

仓库模板有意保持以下安全默认值：

```yaml
groups: []
dws:
  enabled: false
  writesAuthorized: false
```

不要把个人群 ID、DWS profile、Agent 名称、工作目录或职责写入仓库模板；这些内容应保存在本机 DSH 配置和插件 storage 中。

#### 4. 安装 profile 依赖

```powershell
Set-Location "$env:USERPROFILE\.dsh\profiles\web"
pnpm install
```

#### 5. 启动 DSH Web

```powershell
Set-Location D:\path\to\dingtalk-dsh-assistant
pwsh -NoProfile -File .\scripts\start-web.ps1
```

默认 Web 地址由 DSH 提供；resident 插件监听 `127.0.0.1:18998`，允许从 `http://127.0.0.1:3080` 和 `http://localhost:3080` 两个等价的本机 Web 地址访问。通过 `GET http://127.0.0.1:18998/health` 和 `GET http://127.0.0.1:18998/state/dws-bridge` 分别检查 Runtime 与真实 DWS bridge 状态；完整判定和排障步骤见[安装手册](docs/manual/install-and-configure-dsh-web.md)。

`scripts/start-web.ps1` 使用当前用户的 `%USERPROFILE%\.dsh` 作为默认 `DSH_HOME`；若需要隔离 profile，可在启动前显式设置 `DSH_HOME`。脚本从当前项目根启动，并自动发现 `PATH` 中的 Node.js 和全局安装的 DSH。

## 首次配置

启动后，在 DSH Web 的“设置 → 插件 → 钉钉个人助理”中完成配置：

![已选中的钉钉个人助理插件配置](docs/manual/images/dsh-web-plugin-selected-annotated.png)

1. 设置 Agent 名称和别名，多个名称使用英文逗号分隔。群职责定义本群身份关系、负责范围和介入要求；需要作为任务称呼的名字同时加入别名配置。DWS 登录人姓名不享有特殊准入或静默规则。
2. 设置 Agent 工作区绝对目录。DSH 会从该目录原生发现 `AGENTS.md`。
3. 设置默认模型、推理深度和叶子任务并行上限，默认并行上限为 5。
4. 按需设置网络代理。
5. 已切换到 `workflow-v2` 的群使用代码注册的任务流程；配置页展示只读流程目录、消息处理阶段、准入状态、定义版本及节点职责。`GET /state/workflows/catalog` 提供该目录，不返回旧提示词正文。未切换群的旧版叶子任务配置折叠保留，历史 `taskPrompts` 数据不迁移或删除；只配置新流程群时，保存通用 Agent 配置不提交旧提示词字段。
6. 查询已有任务进展由平台内置 `task-progress-query@1` 即时流程处理：校验同群范围、检索候选、回读状态与交付标记、生成答复。定义见目录接口的 `builtInWorkflows`，四步摘要写入消息命令结果供审计；它不会创建任务看板任务。候选超过 8 项时回复明确说明截取范围，标题匹配不等于业务归属已确认。
7. 已切换群的通知首次准备时读取当前“会话职责”的确定性回复规则：需要日常代答署名时，持久正文末尾空一行附 `- 小小鹏代回`；要求引用回复时不允许缺来源而退化为普通群发。已保存通知的正文保持不可变，群职责后来调整不会阻断其发送或回读。第三方任务创建进展同步会静默入账，不生成追问或业务任务；引用能沿已送达通知定位唯一话题时，消息绑定该话题，否则在收信箱显示待归类。已完成的纯排查旧任务再次收到同一问题报告且没有明确修复交办时，先询问是否实施修复；肯定答复才准入新的工作流任务，不改写旧任务。
8. 新消息完成话题关联后，先等待本群已收消息完成归类；同话题消息进入同一个批量意图判断，不同话题各自判断。判断中到达的同话题新消息会使旧候选失效并集合重判。已执行中的任务收到补充时，无影响事实只进入话题账；明确修订走原任务输入变更，仅追加后续阶段不打断当前 Run。一个业务 Task 可登记排查、方案、开发、UAT 等顺序阶段，确认门禁绑定上一阶段产物；下游阶段以独立 Run 执行，看板展示阶段及阻塞原因。未固化事项使用受控 `task-general`，只调用 Host 登记的能力；缺少 UAT/发布适配器时显示具体阻塞，不能把该阶段当作完成。人工重处理消息前核对旧运行的命令和通知：通知一旦尝试发送，就拒绝重处理；尚未领取的通知随旧运行封存，避免旧回复在重处理后发出。
9. 话题意图同时读取关联 Task 的 Run、结果摘要和限制，保留“执行成功”与“目标是否满足”的区别；缺少目标核验证据标为未评估。通知以 `task.accepted`、`task.result` 等业务事件分别去重，同一来源的承接和结果不会互相抵消。工作流通知撤回或补发经 `/workflows/notifications/operations` 逐条预检，再持相同授权来源与事实摘要执行；群负责人授权消息须单独一行写 `撤回通知 <通知ID>` 或 `补发通知 <通知ID>`。ACK 后或外部结果未知时只查询原操作，不重发；历史手工操作用证据对账脚本登记，不调用外部发送。
6. 运行看板中的新任务点击后查看节点执行详情：每个节点的状态、等待原因、产出记录和任务最终结果。节点确有模型会话时可从该节点打开会话记录；旧任务继续使用原有会话入口，卡片上的任务进度样式不变。新发起的工程发现任务由“检查并提出修改”节点按需列路径、搜正文、分段读取文件，不再建立整仓目录索引或单独选文件；Host 在实际写入前校验准入目录和文件哈希。节点领取次数仍由持久上限约束。文件发现、读取及工件交接不设置插件层字节上限，模型和运行环境的实际容量仍需由节点状态回读。

叶子的 `plan-confirmed` 必须用 `workflowAssessment` 绑定当前流程组合，说明沿用证据、不适用步骤以及例外依据。流程例外必须引用固定 Topic 中明确提出该要求的原始消息；主会话生成的目标、验收标准或旧摘要不能覆盖流程。常驻主会话结合可用流程索引和选择原因核查是否漏选，按需读取候选流程；允许有明确理由的无匹配和多个流程组合，不固化业务任务类型。读完已选流程后审阅计划，冲突时返回结构化拒绝。计划、阶段、审阅提交及最终落盘都核对当前启用流程的修订号；配置修改、停用或删除立即使受影响旧审阅失效，无需等待叶子重载。失效待审项归档到执行事件，历史证据保留，重新规划后才可推进。`stage-completed` 每次只提交上一检查点 `remainingItems` 的第一项，`completedItems` 不是累计历史。 checkpoint 按 kind 使用同源契约：plan-confirmed 才允许 workflowAssessment；stage-completed 必须有 stageTask 和非空 evidence；scope-conflict/evidence-gap/risk-changed 可用 stageTask/stageId 标明受影响阶段，但 completedItems 必须为空，不能推进阶段。工具 JSON Schema 由同一 Zod 投影到 DSH 支持的子集，kind/status 分支保留；长度及复杂关联约束由执行时 Zod 精确校验并返回字段路径。错误推进会得到 reviewStatus=rejected 的报告回执及具体缺口，原进度不变；核对该项真实证据并按回执修正，确认接受后再推进下一阶段。
6. 通过群名称模糊搜索添加常驻群，并为每个群配置会话职责。

确认页面的环境检查显示 DWS 已安装、已登录后，再在实际 profile 中启用：

```yaml
dws:
  enabled: true
  writesAuthorized: false
```

先验证真实消息能够进入固定 resident Session，再将 `writesAuthorized` 改为 `true` 开放群聊回复。修改 profile 后需要重启 DSH Web。

完整的逐步安装、页面字段说明和“先收后发”验收流程见[安装插件并在 DSH Web 中完成配置](docs/manual/install-and-configure-dsh-web.md)。

## 群聊工作流

流程契约使用存储 domain v9。已有 v8 数据须按[工作流存储迁移](docs/ops/workflow-storage-migration.md)进行零写自检、独立目标转换和真实 SDK 回读；v6/v7 先按[旧 Topic 迁移](docs/ops/topic-storage-migration.md)得到 v8，再转换到 v9。不能直接用新 Runtime 打开旧存储。活动任务迁移后停在系统等待，显式恢复并重新确认结构化计划后才继续。下文说明代码契约，不代表该版本已发布或本机 profile 已升级。

节点接口与恢复语义见[工作流节点契约](docs/api/workflow-node-contracts.md)。计划以稳定 criterionId/stageId、来源和版本为准；阶段产出引用产物及证据，完成提交包含逐项验收。报告 received、审阅批准、业务应用和通知送达分别记录。完成结果与通知意图同次持久化，通知失败恢复原意图，不重做业务。

已接纳 Decision 的已知本地瞬时存储错误最多尝试三次；未知错误进入 blocked，保留原 operationId 和冲突保留记录。普通消息重试不能解锁未知结果，Host 必须对账后按原操作恢复。Task 取消先保存 stopRequest，未确定的外部动作继续对账，不能把“取消已请求”显示成副作用已撤销。执行许可与 Task 状态分离，等待审阅时停止叶子并释放许可，恢复必须重新排队取得许可。

材料清单、版本和完整性检查由 Host 提前计算；只读注册检查器目前包含产物 SHA256 核验，摘要匹配不代表业务验收通过。外部动作账本只约束已注册适配器，未接入的任意 shell、SQL、部署不会自动获得去重或资源锁保障。

### 常驻主会话

每个群唯一绑定一个 resident Session。群名称、群 ID、职责和稳定决策协议通过 DSH `systemPrompt.section` 注入。消息明确指向已配置的 Agent 名称/别名、使用 `cc:`，或明确确认此前“是否需要我处理”的询问，并形成职责范围内的可验证目标时，主会话可以创建 Task；未明确指名但判断事项应形成任务时，主会话先在群里询问“这个事项是否需要我处理？”，收到肯定答复后再结合原消息和后续补充创建。Host 在接受 `new-task` 时再次校验群职责非空，并要求依据消息明确指向 Agent，或引用本插件此前持久化的 `task-proposal` 询问，不能只信任模型结论。主会话只负责选择 Task 路由；Runtime 使用原始群消息生成来源证据信封交给叶子，主会话生成的根因、完成度、方案优劣或排除性判断不作为叶子事实。

每条新消息先可靠持久化到 Inbox，接收接口随后返回；Resident 使用 `group_topic_route_submit` 对冻结的消息批次先拆分可独立补充、取消、交付、验收和反馈的事项 unit，再分别匹配持久 Topic。一个消息可包含多个 unit，每个 unit 有精确来源、唯一动作 owner 和自己的 `unitId + unitRevision`；四个属于同一交付目标的验收点保持一个事项，独立需求分别处理。超长路由原文通过 `group_topic_route_context_get` 按固定坐标读完，Host 在完整读取、范围覆盖和归属校验前不会接受部分路由。Topic 跨 turn 存在，已归类的无关话题不会使当前话题决策失效。已有 Topic 可与待路由批次交错准备决策；同群模型仍串行，有竞争时每个请求执行一个原生步骤并在工具结果落稳后让出。提交仍核对全部未知输入；返回 `routing-required` 后 Host 保留未接纳草稿，路由完成即按当前来源、版本和回复审阅结果重新校验提交，无需模型重算。同话题新增输入使旧草稿失效，重启则按当前输入重建。无限未分类输入下不承诺提交等待有固定上限。已接受的业务意图仍独立恢复；归类、Topic 决策与 Task 执行分别维护进度，DWS 补拉完成只证明可靠接收。

路由工具成功时只返回 `status` 和 `requestId`（重提已落盘请求另有 `recovered: true`），不在工具输出中复制待决策 Topic 的正文或临时 ID 映射。Host 将各 Topic 的 `[GROUP_TOPIC_DECISION]` 分别投递到常驻会话；`accepted` 仅证明路由落盘，不代表决策、Task 或群回复已完成。决策首屏优先提供本次事项、直接引用、原始点名和 Topic 摘要；同一消息的引用与原文只提供一份。超长段使用 `group_decision_context_get(requestId, section, offset)` 按固定请求连续续读；历史使用 `group_topic_context_get` 按需读取。

Topic 的 `title` 是对齐 Task 名称的 8–20 字短语，最多 30 字，细节保存在 `summary`。v6 迁移形成的历史 Topic 如果摘要为空，Runtime 会先让 Resident 根据其固定版本引用消息生成独立摘要；随后再根据摘要重新概括标题并通过 `group_topic_title_submit` 原子写回，禁止直接截断摘要。摘要和标题分两步提交，每步都校验 Topic 快照，过期结果不会覆盖新内容。

入站消息引用其他钉钉消息时，Steer 信封只携带稳定的引用消息 ID；正常情况下 Resident 直接使用同一会话已经收到的正文。如果该正文因消息传递异常、会话恢复或上下文压缩而不在当前可见上下文，Resident 必须加载 `dingtalk-chat` Skill，并使用插件配置的同一 DWS profile 执行 `chat +messages-mget` 主动读取；取回的消息仍有 `quotedMessage.messageId` 时继续向上查询，直至整条引用链结束。查询结果必须校验完整性，必要时读取链上的图片或文件。查询失败、结果不完整、未命中或检测到循环时，不得要求群成员补发原问题、正文或截图，也不得猜测并回复；本次判断进入 `decision-retrying`，由 Runtime 在故障恢复后自动重试。

`group_decision_submit` 每次提交一个 Topic 的决策，绑定 topicId、revision 和持久 decisionId。决策及每个 Task action 都携带 `basisUnitRefs`，Host 按事项逐动作校验 owner、当前增量和执行版本；接受一个事项不会消费同消息的其他事项。Task 仍只保存 topicRefs，固定版本读取只投影本事项的来源与共享背景。任何 Task 动作都必须带非空确认；确认先可靠写入 Outbox，再创建、续接或重开 Task，但单独确认不消费后续业务动作资格。取消仍优先发送止损信号。决策接受后保留动作回执，按固定 operationId 恢复，不通过重建 ID 重复执行。Topic 工具参数错误返回精简的 `invalid-arguments` 字段问题；归类请求过期时返回当前请求，已落盘的重复提交从 RouteHistory 恢复原回执，Resident 不猜测或盲目重放未知请求。

历史主会话回复候选按 Topic 决策或 Task 通知绑定并有界读取，不随全群历史重复注入。Resident 准备回复时调用 `group_reply_review_get`，完整审阅绑定快照；Topic ID、引用 ID 或关键词不能替代语义判断。重启后从持久的归类进度、Topic 未处理版本和已接受决策恢复；已归类话题的失败只阻塞该话题及共享 Task 的关联操作。

图片及其紧邻短消息在归类阶段共同理解；附件读取失败不能据标题或缩略图猜测正文并启动 Task。原始消息保存附件与事实版本，Topic 固定版本解析相应原始事实，重启后仍能追溯输入。

Task 完成和信息阻塞通知使用 `group_reply_submit` 结构化提交，绑定 Task runSequence、inputVersion、事项来源、相关 Topic 版本及回复快照。每个事项完成后立即进入自己的验收和 Outbox 链路，不等待同消息其他事项；通知请求冻结创建时已接收入站的序号边界，边界后的无关新消息不会扩展旧请求。Resident 根据所引用 Topic 的原始消息选择 `replyToMessageId`；省略 `atOpenDingTalkIds` 时，Runtime 统一从被引用消息推导发送人，显式接收人仍必须属于当前 Topic。当前事项的 Topic 或执行版本变化会使旧通知失效，并在持久协调账中进入 `superseded` 终态。Outbox 待投递、DWS 发送和群回读确认分别计量；通知使用提交 requestId 派生稳定 Outbox 身份，运行层重启或调用方未收到返回值时可读取已接受回执，找不到回执的未知请求不会自动重发。

Topic 决策产生非空回复时，Runtime 使用 DWS 原生引用回复，并验证选定消息属于当前 Topic 快照。原消息的引用链只提供上下文，不自动成为出站引用目标。发送人 ID 缺失时不得猜测引用参数。回读必须匹配正文与精确的引用消息 ID；同文但属于其他话题的引用回复不能认领为本次投递。

任何非空回复提交前，Resident 必须通过 `group_reply_review_get` 按请求 ID 读取 Runtime 绑定的历史确认、近期回复、内容相关回复和当前 Task 关联回复。Resident 根据正文、目标、动作范围和时间线判断同一事项，引用 ID 和相似度只定位候选。等价确认没有新信息时保持静默；必须补全或纠正时，完整审阅后选择当前群真实 Outbox。接纳前校验替换图，原子持久化新通知与替换关系；旧 pending 进入 superseded，不再发送，但这不证明历史从未送达。历史发送未知只核验，迟到回执仍记录实际 messageId。

替换通知先经原生幂等发送及 DWS 回读确认，再独立撤回已授权的旧消息（包括替换链）。撤回失败不再阻塞纠正通知，也不把旧消息伪标撤回：明确服务端拒绝停止自动重试；其它异常按 30 秒间隔最多尝试 3 次，之后等待核验。历史未知查询未命中保留 replacement_delivery_unknown，可由迟到回执继续恢复，不等于确认未发送。发送入口共享群级串行队列，实际外发前再原子检查旧意图未被替换。看板分别展示已替代、撤回待处理、待回读与已回读，保留审计原因。

普通发送遇到明确服务端拒绝时持久化 deliveryBlockedAt，看板显示发送待处理，停止对相同意图自动重试；读取失败或送达未知不冒充明确拒绝，继续保留原生幂等与回读保护。

无任何业务动作或投递记录的阻断通知，可由运维持证据通过 `reconsider` 重新决策；有副作用或结果未知的记录拒绝此操作。详见[本地部署与恢复规程](docs/ops/resident-review-local-deployment.md)。

### 群聊协调决策

决策首包提供固定版本的 `promptIndex` 和合法 `contextSections`；内联消息直接复用，只有分页指针需要 `group_decision_context_get`。流程正文通过同一请求的 `group_task_prompt_get` 批量读取，已有任务用 `group_task_list` / `group_task_context_get` 查询。流程版本改变会使旧读取失效并重新调度。

同群模型保持串行。存在竞争时，决策与审阅每次可连续执行最多三步，或在累计30秒后的步骤边界让出；不会中断正在执行的模型或提交工具。路由仍在步骤边界优先，两批路由后给其他请求公平执行机会。这个预算控制轮转，不承诺真实渠道端到端30秒内完成。

活动记录恢复在后台处理固定快照，再按序接续新事件；启动不等待运行任务的历史统计完全追平。失败保留水位并可恢复，关闭仍等待已排队记录落盘。

### 性能观测与协调资源读取

`GET /state/performance` 是只读观测接口，可按 `day`、`sessionId`、`groupId`、`taskId`、`requestId`、`submissionId` 精确筛选。`rows` 按上海自然日返回模型和工具调用、首流事件/响应/工具耗时分布、上下文及 token 用量；分布包含 `count/sum/max/p50/p95`。`inputTokens` 是未缓存输入；`totalInputTokens` 合计已报告的未缓存、缓存读取和缓存写入，缺失分项另计，不能把未知用量当作已确认的零。模型/工具资源累计耗时与区间并集分别展示，不能把跨行累计值当作端到端等待时间。已有 `/state/task-timings` 继续提供 Task 状态耗时。

`workflow.taskWaits` 从持久状态历史和报告收发边界派生排队、运行、系统等待、人工等待、信息等待及审阅等待，按日对每类区间取并集。旧历史没有 `waitingKind` 时记为 `unknownWait`，不借当前状态猜测历史；报告等待可能与运行状态重叠，不能把这些列当作互斥阶段相加。状态历史没有精确请求/会话/报告关联时，相应筛选返回缺失说明。

`workflow.responses` 只匹配 `replyToMessageId` 精确指向入站消息、且已经保存送达消息 ID 和送达时间的回复；按入站日期归组。`firstReplyMs` 包含确认回执，`firstLabeledSubstantiveReplyMs` 只采用 `replyKind=substantive` 标签，标签不等于人工验证了实质回复内容。未匹配消息返回空值与缺失原因，不记为零耗时。

`coordination.requests` 按请求汇总会话数量、模型输入、未缓存输入及协调消息正文序列化后的字节数；不将字节数折算成 token 或费用。`rows.coordinationQueueMs` 使用 `dingtalk/coordination-dispatched` 中真实入队、分派时刻的差，包含等待轮到本请求及准备会话的时间；重复分派同一消息不重复记录。缺失、倒序时间或请求身份不符单列缺失；旧队列边界没有自动回填。

`observedSince` 和 `coverage=observed-events-only` 标明本投影的观测范围。缺失 usage、首流事件、step 起点或工具配对由缺失计数明确记录；fork seed 和重复投影不计作新模型调用。投影在现有 scheduler 表按会话分区保存，逻辑上更新某会话不改变其它会话的历史，但 single-json 后端仍会重写整个 Domain 文件；计量写入使用全局单写入器，将等待中的同会话事件合成一次持久写，避免多会话计量占满业务写队列，回执仍在持久化后完成；step 结束清理配对状态并压缩已完成步骤身份，缺失工具结果仍保留计数。精确分位频数、去重范围与每日区间并集随保留历史增长，`retention` 明示这一限制，不作任意条数截断。只持久保存计量元数据，不保存正文或工具参数。首流事件不等于首个可见字，更不等于首次实质回复；人工内容标注、全部外部阶段归因和账单计价仍未完成，不能据此承诺费用或真实业务响应收益。

请求会话通过 `group_message_get` 读取本请求消息及引用链，通过 `group_resource_get` 读取消息明确引用的附件或 URL。任意消息 ID、资源 ID 或 URL 被拒绝；分页须连续读取，身份、版本、格式或完整性不符会明确失败。公网文本读取仅允许无凭据的 HTTPS/443、公网 IPv4 DNS 结果；固定本次连接地址，不跟随重定向，不读取内网或环回地址。资源不支持、缺少读取器、图片不可用或正文未读完整时，不得猜测内容或当作证据齐全。

本轮源码实现及验证状态见[性能优化目标与验收记录](docs/acceptance/performance-flow-optimization/goal.md)。本轮尚未部署；独立 DSH glob 责任包只产出本地补丁，未安装到运行 profile。22条带固定前缀的历史失败搜索已完成对照，8条无固定前缀及4条宽 worktrees 查询仍需准确目录输入。上下文、首次实质回复与费用等真实流量收益仍待部署后独立观测，不能由本地用例通过代替。

### 叶子任务

Task 可设置独立的简短标题用于看板展示；标题与 objective 分离，重命名不会改变任务授权范围、Goal 或验收标准。运行看板通过 DSH 官方 `sidebar.footer.action` 提供左侧菜单入口，并由 `shell.overlay` 承载右侧完整内容区域；点击运行看板时切换到看板并清除 Session 选中状态，点击任意 Session 时关闭看板、恢复该 Session 的选中状态与对话/轨迹。运行看板复用 Session 的实际选中背景色，不额外显示焦点边框。

运行看板 Header 的高度和字体规格与 Session 页面一致。各页不再重复显示页面标题和子标题；任务列按 Header 与主内容实际占用计算剩余视口高度，卡片在列内独立滚动，页面本身不会因状态桶高度产生额外补白或纵向滚动。人工介入列表区分待处理、已处理和已失效请求；只有待发送或等待回复的请求提供处理操作，未知状态以异常标记展示且不会导致整个看板崩溃。

Runtime 使用 DSH 原生 subagent 和 Goal 创建叶子 Session。Task 保存标题、目标、验收标准、执行状态、结果，以及 `topicRefs: [{topicId, revision}]` 和 `inputVersion`；不保存 sourceMessageId、triggerHistory、messageHistory 或群消息正文副本。`group_task_context_get` 返回执行约定与 Topic 引用，原始上下文由 `group_topic_context_get` 按固定 revision 分页读取。只有确实影响任务的新增信息才推进 inputVersion，不向每个关联 Task 广播全部讨论。运行中和等待中的 Task 接纳上下文时继续原轮次；完成或归档 Task 只有被明确重开才开启新轮次。目标发生实质变化时，续接动作必须同时提交概括当前完整目标的新标题；Runtime 原子更新目标和标题，并由 objectiveHistory、titleHistory 与 runHistory 保留旧值。普通信息补充、等待恢复和异常唤醒不修改标题，归档不删除历史。叶子完成自身交付与必要自验证后即可提交 `completed`；原群参与者或其他机器人的后续检查属于 Topic 协作，不阻塞叶子 Task。若信息或人工介入确实阻塞本职交付，等待报告需列出 `blockedItems`（未完成要求、来源消息、必要依赖和原因），经 resident 内部审阅后才能进入 waiting。误把他人职责写入目标时，resident 按原消息修订 Task 目标、验收和阶段，保留已完成证据；外部反馈经正常 Topic 输入处理。历史 `coordination` 结果只读兼容，不再重发检查请求。

内部审阅预算等确定性系统故障会将原报告记为 `failed`，Task 进入 `waitingKind=system` 并释放运行名额；Host 通过可靠 Outbox 通知暂停，同一轮次、版本和错误码不重复通知，也不要求叶子反复改稿。恢复入口仍为 `POST /tasks/<taskId>/reports/<submissionId>/retry`。恢复前在 Task 提交锁内只读重建审阅输入，复核报告版本、轮次、当前流程、待处理输入和人工授权；探测失败保持系统等待，不启动叶子或清除故障。通过后在并发容量允许时处理原 submissionId，不能靠创建新报告或会话绕过故障。

派发及重开时，Runtime 从已登记的本地 worktree、已有报告工件、检查点证据和交接记录提取原生绝对路径，检查当前是否存在，随任务输入提供可确认的工作位置。不会遍历工作区寻找这些位置；无法确认时明确标记 unknown。位置存在不代表旧验收仍有效，也不扩大任务授权。优先在已确认的目录检索，避免重新扫描整个工作区。

叶子新建受管理工作区 `worktrees/` 下的 Git linked worktree 后，调用 `task_worktree_register` 登记路径、当前执行版本、创建归属和应保留的 `docs/<类别>/...` 文件清单；文档形成后再次登记更新清单。Host 校验真实路径、Git 身份、当前叶子 Session 及任务归属，并把记录保存到 Task 的 `localWorktrees`。提交 completed 时，`localWorktrees` 列出所有仍登记的目录路径，与 Task 记录一致。任务完成时保留目录和开发分支。归档时先只读预检：Git HEAD 与登记一致、远端分支指向该提交、代码无未提交修改，未跟踪文件全部已列为待迁出文档。然后将文档按原分类复制到当前 Agent 工作区 `docs/<类别>/<taskId>/<仓库名>/`，核对 SHA256，正常执行 `git worktree remove`，并分别回查实际目录及 Git 登记。借用的目录仅记录、不删除；归档失败保留 completed 且不写 `archivedAt`，任务看板显示原因并支持重试。开发分支不会随目录删除；跨轮续作仍使用同一分支。此流程不依赖 `goal.md` 或个人绝对路径。

消息的 `routingStatus` 表示待归类、已归类或归类失败；Topic 的 `processedRevision` 表示决策及所需动作已可靠落地；Task 的输入下发、输入确认与任务完成另行记录。任何一项均不能替代另一项。运行看板的“话题”页在左侧只展示名称与摘要，右侧分开展示完整标题、话题摘要、待解决问题和关联任务；固定版本消息列表直接展示并支持分页，每条消息所引用的上一条消息默认折叠。群消息状态由 `routingStatus`、Topic revision 与 `processedRevision` 投影为“待归类、话题处理中、已处理、归类失败”，不再把旧 `agentDeliveryStatus` 当成业务处理完成度。Task 卡片上的话题链接打开该任务接纳的版本。Topic 归属仅表示消息延续同一讨论目标，或实质改变该 Topic 的事实、范围、结论或动作；为回答问题查询旧分支、PR 或任务资料不会建立 Topic 归属。多 Topic 路由必须逐项声明关系和理由，并显式指定唯一动作主归属。路由回执最多 1 KiB，决策首屏及 `group_decision_context_get` 单页最多 12 KiB，均按完整 UTF-8 JSON 计费；Topic 历史分页仍按原有 40,000 字符预算读取。`omittedDeltaCount` 非零时，Resident 必须读完固定请求的 `messages` 段；其他标记为必要的来源或归属段也须读完。Host 在必要依据读完前拒绝决策，旧历史未读完不会阻塞本次事项。

每个协调 requestId 使用独立的路由、决策或审阅 Session；同一请求的多步读取与有限重试复用该会话，终态释放运行句柄并保留原生日志。Host 继续拥有 Topic、Task、授权、版本和 Outbox 的唯一提交权。工具调用检查当前 groupId、requestId、角色及请求状态，旧会话不能提交新请求或跨群动作。常驻群主会话保留管理用途和原配置权限；请求会话只开放本角色的读取及结构化提交工具，不暴露工程写工具或 Goal 工具。完整工具权限不扩大群消息或 Task 的业务授权，Task 动作仍经 Topic 决策和 Runtime 校验。任务授权与“明确交给其他人”的校验按动作引用的事项判断：从固定版本原文读取该事项之前最近的点名，即使称呼列为 ignoredRefs 也保留证据；同一消息中后续改为点名其他人时，不得借用前一事项的授权。`sourceRefs.quote`、`contextRefs.quote` 只引用当前消息中唯一出现的原文；被引用消息作为独立的 `quotedMessage` 背景提供，不填入当前消息的 `contextRefs`。Task 叶子会话由 Runtime 使用 DSH Goal 管理执行、阻塞、恢复与完成，权限 preset 同为 `danger-full-access`，可按 Task objective 和工作区规则使用完整本机能力。DWS 群通知仍只有 Runtime 一个出口；叶子不得绕过结构化结果链路直接向来源群发送消息。

主会话向运行中或等待中的叶子传递任务上下文、目标修订、真人批复、恢复提示和结果驳回时统一使用 DSH `steer`，在叶子的下一个 step 边界插入，不使用 `followup` 排队到下一 Turn。

群成员明确撤销原任务授权，例如“不要处理、不用做、停止、取消、忽略刚才”时，Resident 将当前撤销消息关联到唯一的 queued、running 或 waiting Task，并提交 `task-cancel`，不得继续作为普通 `task-context` 发送给叶子。Runtime 在等待全局 Task 串行队列前同步调用 DSH `agent.cancel()`，立即中止叶子的当前 Turn 并清空尚未执行的输入；取消建立后拒绝叶子迟到提交的 checkpoint/result。任务随后持久化为已取消，撤销消息及其归属保存在 Topic 历史；叶子 handle 的 dispose 在状态落盘后异步收敛，不阻塞群消息回复或 Web 取消响应，Runtime 关闭时仍会等待其完成。没有待清理自有 worktree 时立即归档；有登记的自有 worktree 时在叶子释放后走同一归档清理流程，失败保留已取消但未归档状态和原因。模糊讨论、普通目标收窄或只暂停某一步不能推断为取消整个 Task。

人工 Web Task 输入通过 `POST /tasks`、`POST /tasks/{taskId}/context` 和 `POST /tasks/{taskId}/reopen` 提交。三者均需由调用方提供稳定 `requestId` 与原始 `context`；新建还需 groupId、title、objective、acceptanceCriteria，可不提供 topicRefs，由 Runtime 建立 Web 来源 Topic。追加和重开需提供 topicRefs、inputVersion、runSequence，均从当前 Task/Topic 查询获得。相同 requestId 只可重试同一内容；版本或身份冲突返回 HTTP 409，持久接受但动作未完成返回 202。body 不接受 taskId、childSessionId 或伪造渠道来源。Resident 不持有这三个 Web 写入口，只通过带原始依据的 `group_decision_submit` 发起业务动作。

取消入口 `POST /tasks/{taskId}/cancel` 同样要求 requestId、topicRefs、inputVersion、runSequence，以 reason 保存人工原文。Web 来源不伪造钉钉引用或 @。Resident 已移除 `group_task_create`、`group_task_context_append`、`group_task_reopen` 直写工具；误归类通过 `group_topic_route_review` 提交修订，所有非空回复必须带 `replyReview.kind`。Task 补充输入按实际值判断范围变化，同值目标、验收和阶段数组不触发重规划。`preserve` 保留仍有效的已确认 checkpoints 及其原 inputVersion，不改写成新版本验收。确需否定既有进展时通过 `impactEvidence` 提供原始 basisMessageIds、原因与 affectedStageIds；从最早受影响阶段失效后续进展，保留此前证据，重新确认实际阶段顺序。明确影响证据不能被 preserve 忽略；未提供依据的同范围 replan 会被拒绝。阶段按稳定 stageId 关联，重复标题或冲突 ID 拒绝。跨 Topic 补充会合并固定版本引用，不覆盖此前执行依据。

叶子报告通过可选 submissionId 或规范内容身份持久接纳，同 ID 不同内容拒绝。回执 contractVersion=2，received:true 只表示已保存；reviewStatus=pending 表示尚未批准推进，approved/rejected/stale/failed 分别表示审阅通过、业务缺口、版本失效和系统故障；applicationStatus 单独表示是否应用；叶子等待 Runtime 事件，不重复提交探测状态。旧版本合法报告只归历史，不覆盖新目标；输入解除或重启从持久记录恢复，审阅和通知复用稳定身份。最终接受、阶段通过与业务验收仍独立核对。

生产发布与数据变更流程的前置核验、离线 revision 候选和配置 CAS 操作见[发布准备证据与流程修订](docs/ops/release-preflight-evidence.md)。缺基础对象为 FAIL，证据或依赖清单不完整为 UNKNOWN，均不能进入生产执行；检查脚本 PASS 仅表示证据契约完整。

Topic 查询的 `processing` 提供最新未完成意图的 decisionId、status、appliedOperations、totalOperations 和有界 error，不返回动作正文。Observer 对应显示处理失败或处理中及动作进度，便于区分消息已接收、Topic 已决策与动作实际完成。

同一消息版本产生过已接受的 Task 动作或确认后，其执行归属保留在持久决策中；将消息从 Topic A 改归 Topic B 不会重新授予执行权。新的授权消息或新的事实版本需要重新判断，历史动作不会因归类修订而自动撤销。

Task 创建和重开时即生成稳定 `stagePlan`，主会话查询与叶子输入使用同一份阶段身份；阶段 ID 的存在不代表计划已批准。`affectedStageIds` 只接受真实 ID，不接受标题或猜测值。创建、重开和上下文修订在 Store 原子接纳点校验阶段及修订参数，接纳和执行共用参数规范化；错误参数不会生成决策、预约或确认，主会话可读取当前上下文后用同一请求纠正重提。

历史已接受的无效上下文修订，仅在整份决策都是 `task-context`、动作映射完整、所有动作未执行且 Task 幂等账本和执行版本均确认安全时，原子标记 `rejected` 并释放自身预约。原消息、Task、历史回复和 processedRevision 保留，Runtime 使用新的稳定请求身份重新判断尚未处理的输入。部分执行、含取消动作或结果不明的记录不会自动退回重放；存储错误仍按原错误链处理。`rejected` 是意图终态，不代表业务输入处理完成。

### 阻塞与人工介入

- 缺少任务信息：叶子进入 information waiting，由主会话结合 Task 所引用 Topic 固定版本的消息时间线，向真正能够补充该信息的一位或多位参与人询问。
- Task 遇到操作红线、环境异常或需要真人判断时进入 `human-intervention`，页面“人工介入”和 DWS 登录人本人私聊共享同一阻塞状态机。批准只对应阻塞单中精确列出的动作；处理意见可以收窄执行方式，不能授权另一动作，和原动作冲突时任务必须继续停住并提交范围冲突。
- waiting 不占 `maxConcurrentTasks` 执行名额；信息或人工回复到达时统一进入 FIFO queued，保留待恢复上下文。调度器把正在创建或恢复 Session 的 Task 计入容量，获得唯一名额后续接原叶子 Session 和 Goal。
- 钉钉人工处理必须引用阻塞消息并提供非空意见；明确回复“拒绝”“不同意”或“不批准”时记为不执行，其余回复使 Task 继续，并保留完整原文。Runtime 使用独立的个人 IM 实时订阅按被引用消息的 `messageId` 精确关联并恢复 Task，历史查询仅用于离线恢复；等待不设超时。
- 批准复用指纹绑定 taskId、runSequence、阻塞类别、规范化动作和风险；旧版本没有这些字段的记录不会自动授权当前轮次。

### 完成通知

任务完成后，叶子把结构化结果交回主会话。主会话结合 Task 所引用 Topic 固定版本的消息时间线选择最适合承接结果的历史消息，并通过结构化 `atOpenDingTalkIds` 通知所有确实需要获知结果或采取后续行动的参与人；Runtime 只接受所引用 Topic 版本中的消息和稳定人员 ID。发送前后均回读钉钉真实消息；包括组织未授权在内的读取失败不能绕过回读，发送受理或空回执不能代替送达证据。未确认的记录保持 pending。Outbox 记录尝试次数、最近尝试时间、失败环节和原因，看板区分待发送、发送受阻、投递异常与待回读。

信息等待通知由 Runtime 固定说明任务已暂停、已完成阶段、剩余缺口、所需资料和恢复条件，并引用相关消息通知反馈人与任务发起人。只有 Outbox 独立回读确认后才标为已送达；30 分钟无新信息提醒一次，2 小时后向发起人升级一次，随后不再自动催促。任务版本变化或恢复会使旧待发通知失效。任务进度、阻塞和完成通知只有 Runtime 一个群聊发送出口；叶子会话不得自行调用 DWS 向来源群发送通知。叶子提交完成结果后，Runtime 会把摘要、证据、交付物、部署信息和Task 所引用 Topic 固定版本的消息时间线交给常驻主会话组织群通知。叶子根据 DSH 注入的 Skill 描述自主选择适用 Skill；Runtime 不绑定具体 Skill，只要求已加载的 Skill 完成其资格判断、必要操作和验证闭环。工作区规则授权范围内的内部维护不扩大业务 Task 授权，也不得借此修改未授权的业务代码、业务数据、环境或外部系统。通知可合并重复表述，但必须保留不同关注点、限定条件、失败项和未验证/未部署边界，不能为了简短只复述摘要。Web 与内部恢复来源只用于触发内部操作，不得伪造群消息或参与人；历史 Task 必须经离线迁移生成可追溯 Topic 引用，不猜测缺失历史。同事或其 AI 助理发送的回复、任务回执和状态通知不会按文案或发送者在模型外过滤，而是进入常驻模型，由模型结合引用、上下文和任务索引决定忽略、回答或关联任务。判断复用已有任务还是新建任务时，必须综合消息前后文、连续消息的信息组、当时场景，以及候选任务的目标、动作范围、状态、完整消息历史和已记录上下文；关键词、词面重合或标题相似只用于寻找候选任务，不能直接作为关联或新建结论。

群消息中的图片、文档、文件、链接或其他外部资源如果承载任务所需信息，Resident 必须先完整读取。无法访问、下载、解析或读取不完整时，Resident 会先明确回复未获取到的具体信息并要求重新提供，不创建、不续接、不重开 Task；不得根据文件名、链接标题、缩略图或零散文字猜测资源正文。Runtime 还会对已知附件读取失败执行硬拦截，避免模型误判后提前启动任务。

叶子提交 `completed` 后，Runtime 会以 coordinator 内部上下文注入的方式，让常驻模型对照当前目标、runSequence、inputVersion 和 Topic 输入版本审查本轮结果和证据，并通过一次 `group_task_review_submit` 同时返回审阅回执与群通知草稿。审阅与回退通知最多内联 20 条、12,000 字符的相关 Topic 消息，整个请求限制为 40,000 字符。超长目标、验收、结果和索引保留 section 指针，通过 group_task_review_context_get 按 nextOffset 续读固定快照；长消息可通过同一工具或固定 Topic 原文分页读取。不能把截断片段当作完整证据。Runtime 只有在审阅通过且 Task 按当前版本原子完成后才将草稿写入发信箱；若期间出现新消息、Topic 或历史回复候选变化，则放弃旧草稿并重新协调。若新增或修订范围未完成、缺少验证，Task 保持 `running`，缺口反馈给原叶子继续执行，不生成完成通知。

除群成员明确撤销整个任务并提交 `task-cancel` 外，`running` 和 `waiting`（包括阻塞中）任务收到新增信息时只追加 `task-context`，继续同一执行轮次；只有 `completed` 任务（包括已归档展示）才允许 reopen 并初始化下一轮。完成轮次的 Session 空闲回收同时绑定 handle、Task 状态和 runSequence，不会释放已经重开的新轮次。Supervisor 发现 `running` Task 的叶子已 idle 时由 Runtime 幂等投递续执行请求；底层明确返回 Agent/Session unavailable 时，受控重建物理叶子并保留同一 Task、目标、Topic 固定版本和执行轮次，不让 Resident 绕用通用子代理消息接口。普通阶段 checkpoint 由 Host 校验版本、阶段身份和证据；按计划顺序推进可直接确认，跨序登记独立阶段必须交 Resident 审阅，不因此跳过业务前置条件。相同未审阅 checkpoint 以持久 checkpointId 复用同一审阅；Supervisor 只恢复该请求，不重复追加。scope-conflict、evidence-gap、risk-changed 在无计划、已拒绝或旧流程失效时仍可报告，不能携带完成项或修改剩余进度；新异常可抢占未确认审阅，旧待审项归档，迟到审阅不得回写。完成审阅发起时即记录 completion-review-requested，拒绝或失败也保留时间与关联尝试标识，Task 完成、通知入队及真实送达分别记录。

### 只读状态问答与模型重试

已明确关联 Task 的简单状态问答可使用独立、无工具的短模型请求，读取当前 Topic 增量、Task 事实快照、审批边界及回复候选；执行动作、授权、复杂冲突或上下文不足时交回常驻处理。短请求沿用当前 Provider、模型和推理设置，提交仍通过 Task 集合、事实版本、策略、Topic 及回复候选校验，并复用原有 Outbox。

直接调用 DSH `LlmRuntime` 不经过 `agent/request-error`，不能假定 AgentLoop 的重试插件会替短请求重试。短问答 handler 是这一条调用链唯一的重试执行者：通过 `prepareCall()` 获取原生 Provider policy，遵守可重试错误码、次数、指数退避、抖动和 Retry-After；所有尝试共享同一请求与输入身份，并受总30秒模型预算限制。失败的部分正文不会提交；耗尽、不可重试或超时才交回常驻。遥测分别记录尝试次数、累计 usage、原生 finish kind/code/status，不记录 Provider 原始错误正文或凭据。

重试规则的确定性测试与真实模型测量见[性能测量记录](docs/acceptance/resident-leaf-coordination-repair/performance-measurement.md)。短模型往返不含路由和钉钉发送，不能代替端到端响应指标。

## Web 运行看板

`dingtalk-dsh-observer` 在 DSH Web header 中提供：

![钉钉个人助理任务看板](docs/manual/images/dsh-web-task-board-annotated.png)

- 群聊会话：查看不同 resident Session 的分页收信箱和发信箱；状态固定在最左列，长内容最多显示两行，完整内容可通过悬停标题或详情查看。
- 任务看板：按待执行、执行中、等待中、已完成展示 Task，并打开 DSH 原生叶子对话和轨迹。活动任务卡片中的“任务”面板默认收起，只显示完成数/总数和进度；展开后显示各阶段任务、状态和耗时。完成结果保留在卡片，完成通知已送达时不重复显示，待送达或受阻时显示状态；协调请求重试耗尽显示“系统协调受阻 · 待恢复”。执行轮次耗时统计不占用任务卡片空间，仍可通过 `/state/task-timings` 接口用于诊断。
- 叶子活动投影写盘遇临时故障会有限重试并暂停该任务的后续投影；监督器按原 Session 事件序号补齐后解除当前故障。任务完成时先补齐活动再释放叶子 Session，持续故障保留恢复问题供排查。
- Runtime 启动后还会逐个审计已完成 Task 的持久 Session；若曾在完成前后漏写活动，按原事件补齐。持续故障保留待审计队列和恢复问题，不会由下一条活动成功自动清除。
- 若历史已完成 Task 的 Session 已不存在，审计将其标为不可回填并从重试队列移出；`/state/activity-audit` 显示待审计、已审计和不可回填项，`/health` 汇总数量。缺少历史来源不伪装成当前写盘故障。
- Outbox 的 `deliveryAttemptCount` 表示投递流程轮数；`sendAttemptCount` 记录实际进入发送调用的次数，`readbackAttemptCount` 记录发送前后读群历史的次数。查询重复发送时应核对这两个计数和远端消息 ID，不能由投递轮数推断重复外发。
- 工具活动从 DSH 的 `tool/call` 和 `tool/result` 关联工具名、错误位、耗时及结果字节数；缺少可关联调用时显示 `unknown`，不推断为成功。
- Task 的 `activityProjection.aggregate` 保存上海本地日期的事件总数和类型计数；500 条活动明细裁剪后累计数仍在。旧存储若已裁剪历史，首次生成的聚合标为 `retained-only`，不可当作历史完整总量。
- 同一消息拆出多个事项时，Resident 新建 Task 必须提供 `dispatchAssessment`：业务对象、当前 Agent 交付、他人后续、来源 Unit、当前流程引用与选择原因。Host 校验来源 Unit、流程启用和版本；单事项可选。业务对象及交付的语义仍由 Resident 按原消息判断。
- Task 收到补充输入后，原版本待审报告转为历史并向仍在运行的叶子提示按当前版本核对后重提；不会自动重放业务操作。明确标记授权变化且有新来源消息时，原阶段批准保守失效，即使阶段名称不变也须重新核对。
- 任务表格同步：在“设置 → 插件 → 钉钉个人助理”填写钉钉在线电子表格地址，检查连接后选择目标工作表并启用。插件启动时立即同步，之后每 180 秒全量覆盖所选工作表；归档 Task 会在下一轮移除。所选工作表由插件托管，手工内容会被覆盖。
- 归档任务：查看已归档 Task，相关群消息仍可重新打开原任务。任务卡片不常驻展示工作目录和文档清单；有登记目录时点击“检查并归档”先核对迁出/清理范围，再确认操作。借用目录及其登记文档保留原处。归档失败在卡片提示，可查看原因后重试；归档后可按需查看目录记录。
- 人工介入：以与消息表格一致的状态列、行高和内容密度分页查看阻塞事项，并在页面明确选择“批准该事项并继续”或“不执行”。
- 告警：按类型查看当前异常和分页的已恢复历史。

看板不读取或重建 DSH Session JSONL，只通过插件状态接口展示业务投影；对话与轨迹仍由 DSH 原生页面负责。

## 状态与数据目录

正式运行使用标准用户级 `DSH_HOME`：

- 插件状态：`%USERPROFILE%\.dsh\storages\dingtalk-dsh-assistant\`
- DSH Session：`%USERPROFILE%\.dsh\sessions\`
- profile：`%USERPROFILE%\.dsh\profiles\`

仓库不提交本机 Session、消息、Task、授权记录、DWS profile、群 ID、打包产物或凭据。

## 开发与测试

```powershell
pnpm install
pnpm test
```

`pnpm test` 以4个文件并发显式运行 `test/*.test.js`，避免自动扫描 `docs/tmp` 中隔离验证的其他业务仓库，以及按CPU核数启动大量真实Git/SQLite测试进程相互争用资源。

测试接口仅在 `testApiEnabled` 显式开启时可用。生产状态接口默认只监听本机地址，不应直接暴露到外网。

关键设计说明：

- [DSH 原生常驻闭环](docs/spec/dsh-native-resident-closure.md)
- [任务 Supervisor](docs/spec/running-task-supervisor.md)
- [人工介入中心](docs/spec/authorization-approval-center.md)
- [钉钉人工介入回复实时生效](docs/spec/approval-reply-live-events.md)
- [运行看板](docs/spec/dingtalk-resident-observer.md)

## 实验性执行底座

独立入口 `@zzusp/dingtalk-dsh-assistant/execution` 提供 M1 的 SQLite 控制账与受信顺序节点，默认不加载。离线初始化、Host 服务注入、恢复及当前能力边界见[执行底座本地运维](docs/ops/execution-foundation-local.md)；现阶段不用于生产任务、shell 或旧 resident 数据迁移。

M2 已增加固定 Git tree 候选验证与显式注册的本地 Git 交付环节，包含控制账发送许可、条件更新及未知结果对账。真实项目 shell、远程平台 PR 和完整业务迁移尚未接入。

受管代际目录从固定基线独立创建，新补充不会自动继承旧代的删除或未跟踪文件；目录归属和未知初始化结果通过同一控制账对账，保留旧目录及用户修改。

### 消息同源编辑与接纳边界

工作流以渠道认证的 `sourceKey + sourceVersion + actorId` 去重。高版本正文完全相同通过 `message.source.alias` 保留原任务与已接纳命令；别名不进入消息处理或通知扫描。正文改变重跑事项拆分、关联和意图判断，并在同库设立源屏障。既有任务必须关联原任务后提交修订、取消、暂停或恢复；无法确定是否新增事项时创建持久澄清请求，不能猜测并重复创建任务。只有明确回答“新增独立任务”才允许新增。

已完成的纯排查事项再次被报告且未明确交办修复时，工作流向原提问者澄清。原提问者和已配置的任务所有者可通过引用该澄清消息答复；其他成员的引用不会消费该请求，也不会阻断群消息补拉。肯定答复仅准入本次消息的新任务，旧任务仍为只读。

消息节点按 S（事项拆分）、R（话题与任务关联）、I（意图）独立计量。当前原文在 S 输入只出现一次；历史消息使用本次快照内的短引用，补取时还原真实来源 ID。R 保留明确引用候选，候选完整详情和已解决材料以持久引用回读，必要证据跨节点传给 I。固定代码产出的节点仍记录执行结果，但不占模型并发或模型额度。节点字节门槛是请求保护值，不等同于提供商 token 容量；账本中的 token 预留仍以请求字节作保守上界，实际 token 以返回 usage 为准。关键材料超过本节点容量时保持可见的待处理状态，不以裁剪后的材料推断无关。

尚未创建执行实例的任务由 `message.task.control` 原子修订或取消原命令；暂停状态在修订后保持暂停。已有实例的修订必须先由 Controller 接纳输入，才能释放编辑屏障。`message.command.reject` 只对 pending 命令生效，确定性拒绝不会进入未知执行状态，并产生可通知的拒绝事实。模型意图节点只获得任务状态投影，不携带整个执行账对象。

消息账分页 `message.list({limit,beforeSequenceId})` 返回 `sequenceId`；历史页与通知待发、未知回查使用独立游标，避免旧未知消息阻塞新通知。必需附件经 `message.material.record` 首次记录后成为同一消息运行内不可变材料，重复读取内容变化拒绝，不能在任务创建时重新读取不同正文。

### 工作流任务的本机 Web 操作

当前新入口可运行通用材料分析、五类按已提供材料区分的只读审查，以及已配置仓库的受管工程交付。五类只读审查分别对应排查、方案、PR 材料、数据口径材料和复盘；它们不读取实时 PR/数据库，也不创建导出文件。UAT 交付、生产发布、UAT 同提交重构建和数据变更已开始代码节点化，但没有可信平台适配器时不进入消息准入，不会假装完成外部操作。迁移矩阵与验证范围见[第 27 轮记录](docs/acceptance/runtime-redesign/round-27.md)。

`POST /tasks/:taskId/context` 和 `/cancel` 对新工作流任务直接进入代码控制器，不调用旧话题协调器。配置须显式提供 `workflow.webActorId`，该本机操作者仍须拥有任务权限；仅接受 loopback 连接及允许的 Web Origin，不接受请求体伪造 actor、任务身份、执行目录或远端基线。

请求必须包含稳定 `requestId`、任务视图中的 `inputVersion` 和 `runSequence`。补充请求传 `context`，取消请求传 `reason`；可附空 `topicRefs`，新任务不要求旧 Topic。相同请求重投复用持久事件，改变同一 requestId 的内容返回 409。补充完整保留旧需求字段和安全约束，仅追加新要求；暂停期间接纳补充不会自动恢复。待处理输入或陈旧版本返回 409。准备事件后进程中断由恢复通路续接稳定 Controller 命令。

新工作流任务当前不支持 Web 归档、改名和重开，对应路径明确返回 `WORKFLOW_WEB_ACTION_UNSUPPORTED`，不写入旧任务账。旧任务仍使用原接口。执行器无法证明排空时，看板显示等待及 Controller 错误原因，不能继续显示为正常运行。

工程固定检查支持 Host 显式配置总预算及每步预算，并将失败检查已采集的受限日志保存为失败节点证据；参数范围、超时归属和准入要求见[检查阶段预算与失败证据](docs/ops/execution-foundation-local.md#工程固定检查的阶段预算与失败证据)。调整预算不等于构建通过。
