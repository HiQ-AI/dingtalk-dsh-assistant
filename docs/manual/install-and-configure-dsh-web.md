# 安装插件并在 DSH Web 中完成配置

本文面向 Windows 11 与 PowerShell 7，说明如何把正式发布的钉钉个人助理插件安装到本机 DSH `web` profile，并在 DSH Web 页面完成首次配置。源码安装只用于开发未发布代码。

发行包由一个入口包和两个内部包组成：

- `dingtalk-dsh-assistant`：对外安装入口，负责把下列两个包加入 DSH Web profile。
- `@zzusp/dingtalk-dsh-assistant`：resident Runtime、钉钉接入和设置页。
- `@zzusp/dingtalk-dsh-observer`：群聊会话、任务、授权和告警看板。

推荐让 Web、resident Runtime 和看板运行在同一个 `dsh web` 进程中，避免多个进程同时写 Session 和插件状态。

## 一、准备环境

需要提前安装：

- Node.js 24 或更高版本。
- pnpm。
- DSH，并确保 `dsh web` 可以启动。
- 已安装并配置所选模型对应的 DSH provider。只有使用 ChatGPT/Codex 订阅调用模型时，才需要安装 `dsh-codex-connect`。
- DWS，并已登录当前需要监听群聊的钉钉账号。

先检查本机命令：

```powershell
node --version
pnpm --version
dsh --version
dws --version
```

Node.js 必须为 `v24` 或更高版本。仅能执行 `dsh --help` 不代表 Web Runtime 可用，安装完成后仍需实际启动并检查页面和健康接口。

## 二、安装或升级正式版本

固定安装当前版本：

```powershell
dsh plugin --profile web add dingtalk-dsh-assistant@0.5.8
```

如需安装 npm 上的最新版本，可省略版本号：

```powershell
dsh plugin --profile web add dingtalk-dsh-assistant
```

该命令直接修改 `%USERPROFILE%\.dsh\profiles\web`，入口包会带入 Assistant、Observer 及其 Web bundle patch。普通安装不需要再手工编辑 `web/package.json` 添加两个内部包。

升级已安装版本：

```powershell
dsh plugin --profile web add @zzusp/dingtalk-dsh-assistant@latest @zzusp/dingtalk-dsh-observer@latest --save-exact
```

DSH Web 会对比 GitHub 最新 Release。“设置 → 插件 → 钉钉个人助理”的“版本与更新”卡片显示版本状态，支持手动检查更新，并可直接查看、复制完整更新命令。该入口只复制上述 DSH 原生命令，不会在运行中覆盖宿主依赖；执行命令后仍需完全重启 DSH Web。

安装或升级后，先在 profile 中确认实际版本，再完全重启 DSH Web：

```powershell
$profilePackage = Get-Content -Raw "$env:USERPROFILE\.dsh\profiles\web\package.json" | ConvertFrom-Json
$profilePackage.dependencies.'dingtalk-dsh-assistant'
```

正式版本与三个 tgz 也可从 [GitHub Releases](https://github.com/HiQ-AI/dingtalk-dsh-assistant/releases) 获取。只下载 tgz 不会自动修改 profile；优先使用 `dsh plugin`，避免手工依赖和 bundle 不一致。

## 三、源码开发安装（可选）

```powershell
git clone https://github.com/HiQ-AI/dingtalk-dsh-assistant.git
Set-Location .\dingtalk-dsh-assistant
pnpm install
pnpm test
```

如果仓库已经存在，直接进入仓库目录，更新代码后重新执行 `pnpm install` 和 `pnpm test`。普通用户已通过上一节安装正式版时，跳过本节和下一节。

后续示例假设仓库绝对路径为：

```text
D:/project/dingtalk-dsh-assistant
```

请替换成自己的真实路径。JSON 中推荐使用 `/`，避免额外转义 Windows 反斜杠。

## 四、把源码包加入 DSH Web profile（可选）

默认 profile 文件位于：

```text
%USERPROFILE%\.dsh\profiles\web\package.json
```

编辑该文件，在现有内容中合并两个本地依赖和两个 bundle。不要覆盖原有的 DSH 依赖、模型 provider 或 bundle。

```json
{
  "dependencies": {
    "@zzusp/dingtalk-dsh-assistant": "file:D:/project/dingtalk-dsh-assistant/packages/dingtalk-dsh-assistant",
    "@zzusp/dingtalk-dsh-observer": "file:D:/project/dingtalk-dsh-assistant/packages/dingtalk-dsh-observer",
    "@deepseek-ai/dsh-storage": "0.1.1-rc.2",
    "@deepseek-ai/dsh-storage-domain": "0.1.1-rc.2",
    "@deepseek-ai/dsh-storage-json": "0.1.1-rc.2"
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

如果使用 ChatGPT/Codex 订阅，再额外加入：

```json
{
  "dependencies": {
    "dsh-codex-connect": "当前兼容版本"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-codex-connect"
      ]
    }
  }
}
```

使用其他模型来源时不要安装 `dsh-codex-connect`，改为保留对应 provider 的依赖、bundle 和认证配置。

启动 DSH Web 后，首页左下角可进入“运行看板”和“设置”；开始会话前还需要在中间区域选择实际工作区。红框为需要关注的入口：

![DSH Web 首页入口](images/dsh-web-home-annotated.png)

进入“设置 → 插件 → 插件列表”，搜索 `dingtalk-dsh`，确认 `dingtalk-dsh-assistant`、`dingtalk-dsh-observer` 和 resident 子插件均为“已启用”：

![DSH Web 插件安装状态](images/dsh-web-plugin-list-annotated.png)

然后切回“插件配置”。红框只标出“钉钉个人助理”配置页入口：

![DSH Web 插件入口](images/dsh-web-plugin-entry-annotated.png)

然后安装该 profile 的依赖：

```powershell
Set-Location "$env:USERPROFILE\.dsh\profiles\web"
pnpm install
```

每次更新插件仓库代码后，都应在这里重新执行一次 `pnpm install`，确保 profile 使用当前本地包。

如果 profile 使用本地 `.tgz`，同一版本重新打包时必须使用新的包文件名并同步修改 `package.json`；只覆盖原同名 tgz 后执行 `pnpm install --force`，仍可能命中锁文件中的旧包完整性记录，导致运行时没有更新。安装后应在 `node_modules` 中独立检查本轮新增实现，再重启 DSH Web。

## 五、装配 resident Runtime

打开仓库中的 `.dsh/profiles/resident/cordis.patch.yml`，把其中配置合并到实际使用的：

```text
%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml
```

必须保留实际 Web profile 已有的 patch。DSH Web 基础 bundle 已经提供 storage、storage-json 和 storage-domain，不能再次 `insert` 同名项；这里只覆盖 storage-json 数据目录并插入 resident 插件。如果已有同名 `id`，应合并配置，不能重复插入：

```yaml
- id: storage-json
  config:
    root: !!js dshHomePath('storages/dingtalk-dsh-assistant')

- insert:
    - id: dingtalk-dsh-assistant
      name: '@zzusp/dingtalk-dsh-assistant/resident'
      config:
        host: 127.0.0.1
        port: 18998
        agentPreset: standard
        fakeModel: false
        resumeTimeoutMs: 10000
        maxConcurrentTasks: 5
        maxGoalRounds: 24
        groups: []
        dws:
          enabled: false
          writesAuthorized: false
```

`agentPreset` 指定 Resident 主会话挂载的 Agent 预设，默认值为 `standard`。使用自定义预设时，应先通过 DSH 的 Agent 预设管理复制并验证预设，再把这里改成对应标识符；不要直接修改 DSH 内置预设文件。

已有 Resident 切换 `agentPreset` 时会沿用原 Session ID 和事件表层，并在成功挂载后回写当前预设标识。不要把历史事件作为新 Session 的 `seed` 重建；`session/end-seed` 会把既有历史划入种子边界，使依赖当前 surface 的自动压缩只能看到边界后的新消息。

默认模型通过实际安装的 provider 配置。例如仅在使用 Codex 订阅时配置：

```yaml
- id: agent-default-model
  config:
    provider: openai-codex
    model: gpt-5.6-sol
```

仓库模板还包含 Session 持久化、指令发现和 telemetry 等当前参考配置。以仓库文件为准整体审阅后再合并，不要只复制上面的核心片段覆盖现有 profile。

### 可选：接入收敛式上下文压缩插件

DSH 官方 `@deepseek-ai/dsh-compaction-basic` 在摘要没有充分缩小时，可能反复选择过小范围而无法把上下文压回阈值。遇到这类不收敛问题时，可用自实现的 [`@zzusp/dsh-compaction-convergent`](https://github.com/zzusp/dsh-compaction-convergent) 替换官方 compaction provider。它保持 `ctx.compaction`、Session 事务和工具配对契约，只调整压力下的范围扩张与重试收敛行为；这不是 `dingtalk-dsh-assistant` 发行包的内置依赖，需要单独安装。

一个 profile 只能启用一个 compaction provider。必须先禁用官方 `compaction-basic`，再插入收敛式实现；只执行插件安装命令不会自动替换 provider。

以下示例固定使用已发布的 `v0.1.1-rc.2-convergent.5`，下载并核对 Release 产物：

```powershell
$compactionReleaseDir = Join-Path $env:TEMP 'dsh-compaction-convergent-5'
New-Item -ItemType Directory -Force -Path $compactionReleaseDir | Out-Null
gh release download v0.1.1-rc.2-convergent.5 `
  --repo zzusp/dsh-compaction-convergent `
  --pattern '*.tgz' `
  --pattern '*.sha256' `
  --pattern 'provenance.json' `
  --dir $compactionReleaseDir

$package = Get-ChildItem -LiteralPath $compactionReleaseDir -Filter '*.tgz' | Select-Object -First 1
$expectedHash = ((Get-Content -LiteralPath "$($package.FullName).sha256" -Raw) -split '\s+')[0].ToUpperInvariant()
$actualHash = (Get-FileHash -LiteralPath $package.FullName -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) { throw 'compaction 插件 SHA-256 校验失败' }

dsh plugin --profile web add $package.FullName
```

同时检查 `provenance.json` 中的 tag、commit 和包名确实属于本次 Release。然后修改 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`。如果文件已有 `- insert:`，把 `compaction-convergent` 合并到现有子项，不要创建重复 `id`：

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  disabled: true

- insert:
    - id: compaction-convergent
      name: '@zzusp/dsh-compaction-convergent'
      config:
        thresholdRatio: 0.8
        retainRatio: 0.16
        maxTokens: 8192
        compactionRetries: 1
        maxOverflowRetries: 1
```

不要把官方 entry 的 `name` 直接改成自实现包名；Cordis Include 的 `name` 是匹配保护条件，不是覆盖字段。`token-meter`、`command-compact` 和 `tool-result-pruner` 继续使用 DSH 官方配置，不要重复注册。

启动前先回读最终配置和实际安装版本：

```powershell
dsh --profile web --dump-config

Push-Location "$env:USERPROFILE\.dsh\profiles\web"
node --input-type=module -e "import meta from '@zzusp/dsh-compaction-convergent/package.json' with { type: 'json' }; console.log(meta.name, meta.version)"
Pop-Location
```

`dump-config` 必须同时显示官方 `compaction-basic` 为 `disabled: true`、`compaction-convergent` 指向自实现包，并且不存在第二个启用的 compaction provider。安装回执和配置展开都不能代替运行态验证；重启后仍需检查 Node 24、Web/Resident listener、health/API，并在可控 Session 中确认压缩发生后 token 下降、Session 可重载且后续消息能继续。

回滚时先停止 Web，删除 `compaction-convergent` 插入项，并把官方 entry 恢复为 `disabled: false`；确认 `dump-config` 只启用官方 provider 后再启动。普通 provider 替换不会自动修复已经被 `session/end-seed` 划到恢复边界前的病理历史 Session；此类一次性修复必须严格按上游的[历史 Session 修复流程](https://github.com/zzusp/dsh-compaction-convergent/blob/main/docs/manual/replace-official-plugin.md#6-历史-session-一次性修复)在副本上执行，不得直接覆盖原 Session。

两个 DWS 开关的含义：

- `enabled: false`：不启动真实群消息监听。
- `enabled: true`、`writesAuthorized: false`：接收和处理真实消息，但禁止自动发群消息，适合首次联调。
- `enabled: true`、`writesAuthorized: true`：允许接收、处理和自动回复，只有只读链路验证通过后再开启。

如需指定非默认 DWS profile，可在 `dws` 下增加：

```yaml
profile: your-profile-name
```

不要把个人群 ID、账号信息、工作目录或代理地址提交到仓库模板。

## 六、启动并确认插件已加载

从插件仓库启动：

```powershell
Set-Location D:\project\dingtalk-dsh-assistant
pwsh -NoProfile -File .\scripts\start-web.ps1
```

脚本默认使用 `%USERPROFILE%\.dsh` 作为 `DSH_HOME`，并设置本机地址不经过代理。如果模型访问需要代理，可显式传入：

```powershell
pwsh -NoProfile -File .\scripts\start-web.ps1 -ProxyUrl 'http://127.0.0.1:10808'
```

启动后用独立只读请求确认 resident Runtime：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:18998/health' | ConvertTo-Json -Depth 10
Invoke-RestMethod -Uri 'http://127.0.0.1:18998/state/dws-bridge' | ConvertTo-Json -Depth 10
```

预期至少看到 `status: "ok"`；真实钉钉模式还应核对 `/health` 的 `transport: "dws"`、`inboundConfigured: true`、`inboundProcessing: true`、`modelMode: "real"`、`outboundAuthorized` 和 `recoveryIssueCount`。`/state/dws-bridge` 必须是 `healthy: true`，且每个已配置群均为 `listener.state: "ready"` 和 `backfill.state: "ok"`。如果端口无法访问，先查看 DSH 启动日志，不要继续配置页面。`lastError` 或 `reconnect.nextRetryAt` 表示 bridge 正在失败或恢复；`lastExitAt` 仅记录最近一次历史退出，应结合当前 `state` 和 `healthy` 判断。端口可访问和静态 `transport: "dws"` 都不能证明新消息正在入站。两项健康接口也不能替代页面、群消息或回复回读验证。

## 七、在 DSH Web 页面配置

打开 DSH Web，进入“设置 → 插件 → 钉钉个人助理”。页面分为运行状态、环境检查、Agent 配置和常驻群配置。

### 1. 检查运行与 DWS 环境

先确认：

- “运行状态”不是连接失败。
- “处理模型”为“真实模型”。
- 环境检查中的 `dws` 为“已安装”。
- 登录状态为“已登录”，并显示预期钉钉账号。

“群消息接收与处理”和“自动回复群聊”分别对应 `enabled` 和 `writesAuthorized`。这两个开关当前不在页面中修改，需要编辑 `cordis.patch.yml` 并重启 DSH Web。

### 2. 填写 Agent 配置

按页面从上到下填写：

- **Agent 名称 / 别名**：多个名称用英文逗号分隔。群消息明确提到任一名称时，Runtime 才会参与新任务判断。
- **工作目录（你的 Agent 目录）**：填写现有工作区的绝对路径。所有常驻主 Session 和叶子任务共用该目录，DSH 会从这里原生发现 `AGENTS.md`。
- **默认处理模型**：填写 DSH 当前可用的模型名，例如 `gpt-5.6-sol`。
- **推理深度**：可选“模型默认、轻度、中度、高度、极高”。存在执行中或等待中的 Task 时不能切换模型。
- **叶子任务并行上限**：范围为 1–50，默认 5。调低不会中断已经运行的任务。
- **网络代理**：仅在 resident Agent 调用模型需要代理时填写，例如 `http://127.0.0.1:10808`；留空表示不使用。保存后立即应用并持久化。
- **任务流程引导**：说明不同任务类型的推进方式。
- **完成证据要求**：说明任务完成时必须提交的可核验证据。

“任务流程引导”和“完成证据要求”只注入叶子 Session，不会注入群常驻主 Session。填写完成后点击“保存配置”，再刷新页面确认字段仍为刚保存的值。

任务流程引导

```text
需求开发/Bug修复：签出开发分支--开发/修复--本地e2e验证通过--提交PR到UAT分支--合并PR--woodpecker自动构建并重启UAT的Pod--检查UAT的Pod重启后运行正常且镜像sha正确--群聊通知--任务进入完成桶--等待群聊发版上线通知--唤起完成任务--提交合并到main分支的PR--合并PR--等所有上线的任务都合并到main分支--走生产发版runbook（打tag推送，等woodpecker自动构建）
```

完成证据要求

```text
需求开发/Bug修复开发完成证据：
1. 开发分支
2. 本地e2e通过
3. 合并到UAT分支的PR且已合并
4. woodpecker自动构建完成
5. UAT的Pod重启后运行正常且镜像sha正确
6. 通知常驻主会话
```

红框依次标出工作目录、模型与推理深度、并行上限和网络代理：

![Agent 配置](images/dsh-web-assistant-config-annotated.png)

### 3. 添加常驻群

在“常驻群与会话职责 → 添加常驻群”中：

1. 输入至少两个字的群名称并点击“搜索”。
2. 从结果中选择目标群，核对群名、成员数和群 ID。
3. 填写该群的会话职责，包括职责范围、参与条件和需要升级给真人的边界。
4. 点击“添加并开始常驻”。

红框标出完成证据、保存按钮、群搜索和会话职责。群搜索结果属于真实钉钉数据，因此示例图停留在输入前：

![常驻群与会话职责配置](images/dsh-web-group-config-annotated.png)

会话职责配置（按实际场景修改对应内容）

```text

## 职责与介入

负责 xxx 项目及其直接关联项目的问答、方案、评审、排查和开发协作，包括 a项目、b项目、c项目，以及相关数据库、服务器、k3s、Git issue/PR 等事项。

作为本群常驻主会话，持续理解群聊上下文并判断是否介入。默认保持安静；只有能够补充新的事实或结论、纠正明确错误或风险、解除讨论阻塞，或者事项明确由自己负责、被明确要求处理时才介入。已创建或正在处理的任务收到新的执行线索、补充信息或处理要求时，使用一句短句确认已收到并会继续处理，不复述对方提供的信息。

已有充分回答、已有明确负责人处理且无新增风险、闲聊、普通状态同步、同事间讨论、单纯事实陈述或尚未形成可验证目标时，不回复，也不创建任务。

## 任务准入

事项属于职责范围、已经形成可验证目标，并满足以下任一条件时，可以创建或续接任务：

- 消息明确要求“张三的Agent”或“张三”处理该事项；
- 消息对“张三的Agent”或“张三”有明确处理指向，而非仅仅提及；
- 对方明确确认了此前“这个事项是否需要我处理？”的询问；
- 已有对应任务，当前消息是在补充信息、调整目标或要求继续处理。

未明确要求处理，但判断事项有必要形成任务时，先在群里询问：

> 这个事项是否需要我处理？

收到明确肯定答复后，再结合原消息和后续补充创建任务。不得仅凭事项与职责相关、讨论热度或主观判断直接创建任务。

创建任务只代表同意处理该事项，不代表已经授权实施修改；任务的执行范围仍须根据用户的具体指令单独判断。

## 任务授权边界

任务分为两类：

- **排查分析类**：“看看、查一下、排查、分析、定位、评审、给方案”等，仅授权调查取证、复现问题、定位根因、评估影响和提出方案。
- **实现修复类**：“修改、修复、实现、开发、改掉、处理并提交、排查并修复”等，才授权实施相应变更、验证和交付。

排查分析不包含实现修复。即使已经确认根因和修复方式，也不得自行修改代码、配置、数据或运行环境，不得提交代码、推送分支、创建或更新 PR、部署，或执行其他会改变持久状态的操作。

排查完成后，应先返回分析结论、核验证据、影响范围和建议方案。如果确实存在可实施且属于职责范围的修复方案，再询问：

> 已定位问题及建议修复方案，是否需要我继续实施修复并完成验证？

只有收到明确肯定答复后，才能进入实现修复。原始要求已经明确包含“排查并修复”的，无需重复确认。

如果无法判断用户授权的是排查分析还是实现修复，一律按排查分析处理。不得因为修复简单、顺手可做、风险较低或方案已经明确而自行扩大任务范围。

## 事实依据

群内结论必须基于自己取得并核验的当前代码、数据、日志、运行状态或权威文档。他人的描述只能作为待核线索，不得直接当作已确认事实。

身份、项目规则、授权边界和对外发声要求最终以 `D:\baibu-agent\AGENTS.md` 为准；如有冲突，以该文件为准。
```

添加后会为该群建立唯一的 resident Session。已有群的职责可单独编辑并点击“保存职责”。删除常驻群会移除插件中的群配置；存在活动 Task 时删除会被拒绝。

## 八、按“先收后发”启用真实群聊

首次上线不要直接开放自动回复。

### 阶段 1：只开启接收

修改实际 Web profile：

```yaml
dws:
  enabled: true
  writesAuthorized: false
```

重启 DSH Web 后确认页面显示：

- 群消息接收与处理：已启用。
- 自动回复群聊：未启用。

在已添加的测试群发送一条消息，然后从左侧插件看板打开“群聊会话”，确认消息进入该群固定的 resident Session。不要用启动成功或健康接口代替这一步真实消息验证。

任务进入 Runtime 后，可从左侧菜单打开“运行看板”，再进入“任务看板”，按待执行、执行中、等待中和已完成四列检查状态。运行看板会替换右侧内容区域，左侧菜单和 Session 页面保持独立；页面不重复显示标题和子标题，状态桶使用剩余视口高度，卡片在桶内滚动，不会把页面撑高。执行中/等待中卡片内的“任务”面板默认收起，只保留完成数/总数和进度；点击后展开各阶段任务、完成状态和单项执行时长。Runtime 会强制叶子按当前顺序逐项提交完成事件，禁止批量跳过检查点，并在 remainingItems 清空前拒绝完成 Task，确保后续任务的每个检查点都有可计算的独立时间边界。已完成、已归档任务不再重复展示该面板。红框标出任务看板入口和完整任务区域：

![DSH Web 任务看板](images/dsh-web-task-board-annotated.png)

### 阶段 2：开放回复

只读链路通过后再修改为：

```yaml
dws:
  enabled: true
  writesAuthorized: true
```

重启后确认页面“自动回复群聊”为“已启用”。在测试群发起一条明确提到 Agent 名称、且符合群职责的最小任务，最终应同时确认：

- 群消息进入原 resident Session。
- 任务看板出现独立叶子 Task。
- Task 完成后，原群收到引用回复并正确 @任务提出人。
- 回读到钉钉真实消息后，投递状态才显示完成。

## 九、常见问题

### 设置页没有“钉钉个人助理”

检查两个本地依赖是否已经写入 `web/package.json`，两个 bundle 是否都存在，并在 profile 目录重新运行 `pnpm install`。随后完全重启 `dsh web`。

### 页面提示无法连接 resident 插件

检查 DSH 日志中是否加载了 `@zzusp/dingtalk-dsh-assistant/resident`，并确认 `127.0.0.1:18998` 未被其他进程占用：

```powershell
Get-NetTCPConnection -LocalPort 18998 -ErrorAction SilentlyContinue
```

### DWS 已安装但显示未登录

在同一 Windows 用户和同一 DWS profile 下重新完成登录，再点击设置页“刷新”。不要复制或保存 OAuth 回调地址、授权码或 token 到文档和仓库。

### 健康接口可读，但新群消息未进入

先读取 `/health` 和 `/state/dws-bridge`。若任一已配置群的 `listener.state` 不是 `ready`，或出现 `lastError`、`reconnect.nextRetryAt`，先查看 DSH 启动日志中的对应错误，并确认该 DWS profile 的登录仍然有效；bridge 会自动重连。`lastExitAt` 只说明曾经退出，仍需结合当前 `state` 和 `healthy` 判断。若 `backfill.state` 不是 `ok`，根据其 `lastError` 排查 DWS 范围读取。随后读取 `/state/groups`，确认目标群仍已订阅。待 listener 恢复为 `ready` 且 backfill 恢复为 `ok` 后，在可控群发送一条新消息，并回读收信箱或 resident Session；诊断接口的恢复不能代替这一步业务验证。

### 群搜索失败

确认 DWS 登录有效，搜索词不少于两个字；如果配置了 `dws.profile`，确认登录的是同一个 profile。

### 模型请求失败

先确认当前所选模型 provider 的认证有效，再检查页面中的模型名和代理。只有使用 Codex 订阅时才检查 `dsh-codex-connect` 登录。代理环境下应确保 `localhost`、`127.0.0.1` 不走代理；仓库启动脚本已经设置该规则。

## 十、安装完成判定

只有以下各层都通过，才算完成：

1. `pnpm test` 通过。
2. DSH Web profile 依赖安装成功，两个插件 bundle 均被加载。
3. `GET http://127.0.0.1:18998/health` 与 `GET http://127.0.0.1:18998/state/dws-bridge` 可读；真实 DWS 模式满足上述 listener 与 backfill 健康条件。
4. 设置页能读回 Agent 配置，DWS 环境检查正确。
5. 目标群成功绑定唯一 resident Session。
6. 真实群消息进入该 Session。
7. 开放写入后，最小任务完成回复并经钉钉回读确认。
8. 运行看板中的收信箱、发信箱、阶段任务和状态与实际 Session/钉钉回读一致；消息与审批表格的状态列位于最左侧，长内容最多显示两行，任务状态桶不产生页面级纵向滚动。

前一层的成功不能替代后一层的验证。
