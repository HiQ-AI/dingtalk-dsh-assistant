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

维护者发布新版本时，先将根包、assistant 和 observer 的版本号及 `CHANGELOG.md` 更新为同一版本并合并到 `main`，再推送对应的 `v<version>` Tag。GitHub Actions 会在 Node.js 24.19.0 下重新构建、测试和打包，按 observer → assistant → 根发行包的顺序发布 npm；三个包回读一致后才创建 GitHub Release。发布 job 绑定 GitHub Environment `NPM_PUBLISH`，优先使用其中的 `NPM_PUBLISH_TOKEN`，未配置时回退到 `NPM_TOKEN`。

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

1. 设置 Agent 名称和别名，多个名称使用英文逗号分隔。
2. 设置 Agent 工作区绝对目录。DSH 会从该目录原生发现 `AGENTS.md`。
3. 设置默认模型、推理深度和叶子任务并行上限，默认并行上限为 5。
4. 按需设置网络代理。
5. 填写叶子会话提示词；该内容只注入叶子 Session，可统一描述任务流程、完成证据和其他执行约束。
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

Topic 处理模型使用存储 domain v7。已有 v6 数据必须先按[离线迁移与回退说明](docs/ops/topic-storage-migration.md)完成只读检查、独立目标转换和回读，再切换运行配置；不能直接用新 Runtime 打开旧存储。下文说明代码契约，不代表该版本已发布或本机 profile 已升级。

### 常驻主会话

每个群唯一绑定一个 resident Session。群名称、群 ID、职责和稳定决策协议通过 DSH `systemPrompt.section` 注入。消息明确指向已配置的 Agent 名称/别名、使用 `cc:`，或明确确认此前“是否需要我处理”的询问，并形成职责范围内的可验证目标时，主会话可以创建 Task；未明确指名但判断事项应形成任务时，主会话先在群里询问“这个事项是否需要我处理？”，收到肯定答复后再结合原消息和后续补充创建。Host 在接受 `new-task` 时再次校验群职责非空，并要求依据消息明确指向 Agent，或引用本插件此前持久化的 `task-proposal` 询问，不能只信任模型结论。主会话只负责选择 Task 路由；Runtime 使用原始群消息生成来源证据信封交给叶子，主会话生成的根因、完成度、方案优劣或排除性判断不作为叶子事实。

每条新消息先可靠持久化到 Inbox，接收接口随后返回；Resident 使用 `group_topic_route_submit` 对冻结的消息批次归类，再以 Topic 为单位处理增量。Topic 跨 turn 存在，一个消息可以关联多个 Topic；已归类的无关话题不会使当前话题决策失效。同群仍有未归类输入时，应先完成归类再判断其影响。归类、Topic 决策与 Task 执行分别维护进度，DWS 补拉完成只证明可靠接收。

Topic 的 `title` 是对齐 Task 名称的 8–20 字短语，最多 30 字，细节保存在 `summary`。v6 迁移形成的历史 Topic 如果摘要为空，Runtime 会先让 Resident 根据其固定版本引用消息生成独立摘要；随后再根据摘要重新概括标题并通过 `group_topic_title_submit` 原子写回，禁止直接截断摘要。摘要和标题分两步提交，每步都校验 Topic 快照，过期结果不会覆盖新内容。

入站消息引用其他钉钉消息时，Steer 信封只携带稳定的引用消息 ID；正常情况下 Resident 直接使用同一会话已经收到的正文。如果该正文因消息传递异常、会话恢复或上下文压缩而不在当前可见上下文，Resident 必须加载 `dingtalk-chat` Skill，并使用插件配置的同一 DWS profile 执行 `chat +messages-mget` 主动读取；取回的消息仍有 `quotedMessage.messageId` 时继续向上查询，直至整条引用链结束。查询结果必须校验完整性，必要时读取链上的图片或文件。查询失败、结果不完整、未命中或检测到循环时，不得要求群成员补发原问题、正文或截图，也不得猜测并回复；本次判断进入 `decision-retrying`，由 Runtime 在故障恢复后自动重试。

`group_decision_submit` 每次提交一个 Topic 的决策，绑定 topicId、revision 和持久 decisionId。提交时复核未归类输入、相关 Topic 版本、Task inputVersion 以及历史回复快照；发生冲突时零副作用拒绝。Task 动作用 topicRefs 引用固定版本，具体消息授权证据仍在 Topic 决策中校验，加入 Topic 本身不会扩大授权。任何 Task 动作都必须带非空确认；确认先可靠写入 Outbox，再创建、续接或重开 Task。取消仍优先发送止损信号。决策接受后保留动作回执，按固定操作身份恢复，不通过重建 ID 重复执行。

历史主会话回复候选按 Topic 决策或 Task 通知绑定并有界读取，不随全群历史重复注入。Resident 准备回复时调用 `group_reply_review_get`，完整审阅绑定快照；Topic ID、引用 ID 或关键词不能替代语义判断。重启后从持久的归类进度、Topic 未处理版本和已接受决策恢复；已归类话题的失败只阻塞该话题及共享 Task 的关联操作。

图片及其紧邻短消息在归类阶段共同理解；附件读取失败不能据标题或缩略图猜测正文并启动 Task。原始消息保存附件与事实版本，Topic 固定版本解析相应原始事实，重启后仍能追溯输入。

Task 完成和信息阻塞通知使用 `group_reply_submit` 结构化提交，绑定 Task runSequence、inputVersion、相关 Topic 版本及回复快照。Resident 根据所引用 Topic 的原始消息选择 `replyToMessageId` 和 `atOpenDingTalkIds`；Runtime 核对真实消息与稳定参与人身份。Topic 新增信息影响当前输入或其他路径已修改 Task 时，旧通知不得直接提交。Outbox 已落盘和 DWS 已投递分别计量，稳定通知身份支持失败恢复。

Topic 决策产生非空回复时，Runtime 使用 DWS 原生引用回复，并验证选定消息属于当前 Topic 快照。原消息的引用链只提供上下文，不自动成为出站引用目标。发送人 ID 缺失时不得猜测引用参数。回读必须匹配正文与精确的引用消息 ID；同文但属于其他话题的引用回复不能认领为本次投递。

任何非空回复提交前，Resident 必须通过 `group_reply_review_get` 按请求 ID 读取 Runtime 绑定的未撤回历史确认、近期回复、内容相关回复和当前 Task 关联回复。Resident 根据消息正文、任务目标、动作范围和时间线判断是否属于同一事项；引用消息 ID 和词面相似度只用于定位候选。若同一事项已有等价确认且没有新信息，本次保持静默；若确认内容必须补全，则只允许选择本插件已发送且已经 DWS 回读的旧 Outbox，先经 DWS 撤回并验证不存在，再发送一条合并后的最新确认。候选未完整审阅或旧消息尚未回读时拒绝新意图；审阅通过后先持久化新 Outbox 和替换关系，再由渠道发送前完成精确撤回。撤回失败保持 pending，不发送新回复，后续按同一意图重试。

### 叶子任务

Task 可设置独立的简短标题用于看板展示；标题与 objective 分离，重命名不会改变任务授权范围、Goal 或验收标准。运行看板通过 DSH 官方 `sidebar.footer.action` 提供左侧菜单入口，并由 `shell.overlay` 承载右侧完整内容区域；点击运行看板时切换到看板并清除 Session 选中状态，点击任意 Session 时关闭看板、恢复该 Session 的选中状态与对话/轨迹。运行看板复用 Session 的实际选中背景色，不额外显示焦点边框。

运行看板 Header 的高度和字体规格与 Session 页面一致。各页不再重复显示页面标题和子标题；任务列按 Header 与主内容实际占用计算剩余视口高度，卡片在列内独立滚动，页面本身不会因状态桶高度产生额外补白或纵向滚动。

Runtime 使用 DSH 原生 subagent 和 Goal 创建叶子 Session。Task 保存标题、目标、验收标准、执行状态、结果，以及 `topicRefs: [{topicId, revision}]` 和 `inputVersion`；不保存 sourceMessageId、triggerHistory、messageHistory 或群消息正文副本。`group_task_context_get` 返回执行约定与 Topic 引用，原始上下文由 `group_topic_context_get` 按固定 revision 分页读取。只有确实影响任务的新增信息才推进 inputVersion，不向每个关联 Task 广播全部讨论。运行中和等待中的 Task 接纳上下文时继续原轮次；完成或归档 Task 只有被明确重开才开启新轮次。runHistory 和 objectiveHistory 保留 Topic 版本与执行版本，归档不删除历史。

消息的 `routingStatus` 表示待归类、已归类或归类失败；Topic 的 `processedRevision` 表示决策及所需动作已可靠落地；Task 的输入下发、输入确认与任务完成另行记录。任何一项均不能替代另一项。运行看板的“话题”页在左侧只展示名称与摘要，右侧分开展示完整标题、话题摘要、待解决问题和关联任务；固定版本消息列表直接展示并支持分页，每条消息所引用的上一条消息默认折叠。群消息状态由 `routingStatus`、Topic revision 与 `processedRevision` 投影为“待归类、话题处理中、已处理、归类失败”，不再把旧 `agentDeliveryStatus` 当成业务处理完成度。Task 卡片上的话题链接打开该任务接纳的版本。Topic 归属仅表示消息延续同一讨论目标，或实质改变该 Topic 的事实、范围、结论或动作；为回答问题查询旧分支、PR 或任务资料不会建立 Topic 归属。多 Topic 路由必须逐项声明关系和理由，并显式指定唯一动作主归属。Topic 决策信封和 `group_topic_context_get` 的单次完整 JSON 返回均限制为 40,000 字符；读取方按 `nextOffset`/`nextTextOffset` 连续读取分页或超长消息片段。`omittedDeltaMessageIds` 非空时，Resident 必须读完该固定 revision 的全部缺失增量，Host 在读完前拒绝决策。

常驻群聊主会话只负责上下文理解和结构化选路，不暴露 `get_goal`、`create_goal`、`update_goal`，也不注入 Goal 工具说明；其 DSH 文件权限 preset 固定为 `read-only`。Task 叶子会话由 Runtime 使用 DSH Goal 管理执行、阻塞、恢复与完成，权限 preset 为 `danger-full-access`，可按 Task objective 和工作区规则使用完整本机能力。DWS 群通知仍只有 Runtime 一个出口；叶子不得绕过结构化结果链路直接向来源群发送消息。

主会话向运行中或等待中的叶子传递任务上下文、目标修订、真人批复、恢复提示和结果驳回时统一使用 DSH `steer`，在叶子的下一个 step 边界插入，不使用 `followup` 排队到下一 Turn。

群成员明确撤销原任务授权，例如“不要处理、不用做、停止、取消、忽略刚才”时，Resident 将当前撤销消息关联到唯一的 queued、running 或 waiting Task，并提交 `task-cancel`，不得继续作为普通 `task-context` 发送给叶子。Runtime 在等待全局 Task 串行队列前同步调用 DSH `agent.cancel()`，立即中止叶子的当前 Turn 并清空尚未执行的输入；取消建立后拒绝叶子迟到提交的 checkpoint/result。任务随后持久化为已取消并归档，撤销消息及其归属保存在 Topic 历史；叶子 handle 的 dispose 在状态落盘后异步收敛，不阻塞群消息回复或 Web 取消响应，Runtime 关闭时仍会等待其完成。模糊讨论、普通目标收窄或只暂停某一步不能推断为取消整个 Task。

人工 Web Task 输入通过 `POST /tasks`、`POST /tasks/{taskId}/context` 和 `POST /tasks/{taskId}/reopen` 提交。三者均需由调用方提供稳定 `requestId` 与原始 `context`；新建还需 groupId、title、objective、acceptanceCriteria，可不提供 topicRefs，由 Runtime 建立 Web 来源 Topic。追加和重开需提供 topicRefs、inputVersion、runSequence，均从当前 Task/Topic 查询获得。相同 requestId 只可重试同一内容；版本或身份冲突返回 HTTP 409，持久接受但动作未完成返回 202。body 不接受 taskId、childSessionId 或伪造渠道来源。Resident 不持有这三个 Web 写入口，只通过带原始依据的 `group_decision_submit` 发起业务动作。

取消入口 `POST /tasks/{taskId}/cancel` 同样要求 requestId、topicRefs、inputVersion、runSequence，以 reason 保存人工原文。Web 来源不伪造钉钉引用或 @。Resident 已移除 `group_task_create`、`group_task_context_append`、`group_task_reopen` 直写工具；误归类通过 `group_topic_route_review` 提交修订，所有非空回复必须带 `replyReview.kind`。Task 补充输入必须声明 `progressImpact`。仅当目标、验收、阶段和既有证据有效性均未变化时，`preserve` 才保留已确认 checkpoints，并将其重绑到新 inputVersion；旧版本待审项作废并归入执行事件，要求按新版本重新提交。其他情况按 `replan` 归档全部旧进度，并要求重新提交 plan-confirmed。跨 Topic 补充会合并固定版本引用，不覆盖此前执行依据。

Topic 查询的 `processing` 提供最新未完成意图的 decisionId、status、appliedOperations、totalOperations 和有界 error，不返回动作正文。Observer 对应显示处理失败或处理中及动作进度，便于区分消息已接收、Topic 已决策与动作实际完成。

同一消息版本产生过已接受的 Task 动作或确认后，其执行归属保留在持久决策中；将消息从 Topic A 改归 Topic B 不会重新授予执行权。新的授权消息或新的事实版本需要重新判断，历史动作不会因归类修订而自动撤销。

### 阻塞与人工介入

- 缺少任务信息：叶子进入 information waiting，由主会话结合 Task 所引用 Topic 固定版本的消息时间线，向真正能够补充该信息的一位或多位参与人询问。
- Task 遇到操作红线、环境异常或需要真人判断时进入 `human-intervention`，页面“人工介入”和 DWS 登录人本人私聊共享同一阻塞状态机。
- waiting 不占 `maxConcurrentTasks` 执行名额；信息或人工回复到达时统一进入 FIFO queued，保留待恢复上下文。调度器把正在创建或恢复 Session 的 Task 计入容量，获得唯一名额后续接原叶子 Session 和 Goal。
- 钉钉人工处理必须引用阻塞消息并提供非空意见；明确回复“拒绝”“不同意”或“不批准”时记为不执行，其余回复使 Task 继续，并保留完整原文。Runtime 使用独立的个人 IM 实时订阅按被引用消息的 `messageId` 精确关联并恢复 Task，历史查询仅用于离线恢复；等待不设超时。
- 批准复用指纹绑定 taskId、runSequence、阻塞类别、规范化动作和风险；旧版本没有这些字段的记录不会自动授权当前轮次。

### 完成通知

任务完成后，叶子把结构化结果交回主会话。主会话结合 Task 所引用 Topic 固定版本的消息时间线选择最适合承接结果的历史消息，并通过结构化 `atOpenDingTalkIds` 通知所有确实需要获知结果或采取后续行动的参与人；Runtime 只接受所引用 Topic 版本中的消息和稳定人员 ID。发送后必须回读钉钉真实消息才将 outbox 标记为已投递。

任务进度、阻塞和完成通知只有 Runtime 一个群聊发送出口；叶子会话不得自行调用 DWS 向来源群发送通知。叶子提交完成结果后，Runtime 会把摘要、证据、交付物、部署信息和Task 所引用 Topic 固定版本的消息时间线交给常驻主会话组织群通知。叶子根据 DSH 注入的 Skill 描述自主选择适用 Skill；Runtime 不绑定具体 Skill，只要求已加载的 Skill 完成其资格判断、必要操作和验证闭环。工作区规则授权范围内的内部维护不扩大业务 Task 授权，也不得借此修改未授权的业务代码、业务数据、环境或外部系统。通知可合并重复表述，但必须保留不同关注点、限定条件、失败项和未验证/未部署边界，不能为了简短只复述摘要。Web 与内部恢复来源只用于触发内部操作，不得伪造群消息或参与人；历史 Task 必须经离线迁移生成可追溯 Topic 引用，不猜测缺失历史。同事或其 AI 助理发送的回复、任务回执和状态通知不会按文案或发送者在模型外过滤，而是进入常驻模型，由模型结合引用、上下文和任务索引决定忽略、回答或关联任务。判断复用已有任务还是新建任务时，必须综合消息前后文、连续消息的信息组、当时场景，以及候选任务的目标、动作范围、状态、完整消息历史和已记录上下文；关键词、词面重合或标题相似只用于寻找候选任务，不能直接作为关联或新建结论。

群消息中的图片、文档、文件、链接或其他外部资源如果承载任务所需信息，Resident 必须先完整读取。无法访问、下载、解析或读取不完整时，Resident 会先明确回复未获取到的具体信息并要求重新提供，不创建、不续接、不重开 Task；不得根据文件名、链接标题、缩略图或零散文字猜测资源正文。Runtime 还会对已知附件读取失败执行硬拦截，避免模型误判后提前启动任务。

叶子提交 `completed` 后，Runtime 会先以 coordinator 内部上下文注入的方式，让常驻模型对照当前目标、runSequence、inputVersion 和 Topic 输入版本审查本轮结果和证据，并通过 `group_task_review_submit` 返回独立审阅回执；该验收不是群成员消息，不得回复群聊或写入发信箱。若新增或修订范围未完成、缺少验证，Task 保持 `running`，缺口反馈给原叶子继续执行，不生成完成通知。

除群成员明确撤销整个任务并提交 `task-cancel` 外，`running` 和 `waiting`（包括阻塞中）任务收到新增信息时只追加 `task-context`，继续同一执行轮次；只有 `completed` 任务（包括已归档展示）才允许 reopen 并初始化下一轮。完成轮次的 Session 空闲回收同时绑定 handle、Task 状态和 runSequence，不会释放已经重开的新轮次。普通阶段 checkpoint 由 Host 校验版本、顺序和证据后直接确认；计划、冲突、范围或风险变化等需要语义判断的 checkpoint 才交给 Resident。相同未审阅 checkpoint 以持久 checkpointId 复用同一审阅；Supervisor 只恢复该请求，不重复追加。

## Web 运行看板

`dingtalk-dsh-observer` 在 DSH Web header 中提供：

![钉钉个人助理任务看板](docs/manual/images/dsh-web-task-board-annotated.png)

- 群聊会话：查看不同 resident Session 的分页收信箱和发信箱；状态固定在最左列，长内容最多显示两行，完整内容可通过悬停标题或详情查看。
- 任务看板：按待执行、执行中、等待中、已完成展示 Task，并打开 DSH 原生叶子对话和轨迹。活动任务卡片中的“任务”面板默认收起，只显示完成数/总数和进度；展开后显示各阶段任务、状态和耗时。执行轮次耗时统计不占用任务卡片空间，仍可通过 `/state/task-timings` 接口用于诊断。
- 归档任务：查看已归档 Task，相关群消息仍可重新打开原任务。
- 人工介入：以与消息表格一致的状态列、行高和内容密度分页查看阻塞事项，并在页面选择继续任务或不执行。
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

测试接口仅在 `testApiEnabled` 显式开启时可用。生产状态接口默认只监听本机地址，不应直接暴露到外网。

关键设计说明：

- [DSH 原生常驻闭环](docs/spec/dsh-native-resident-closure.md)
- [任务 Supervisor](docs/spec/running-task-supervisor.md)
- [人工介入中心](docs/spec/authorization-approval-center.md)
- [钉钉人工介入回复实时生效](docs/spec/approval-reply-live-events.md)
- [运行看板](docs/spec/dingtalk-resident-observer.md)
