# Issue 172：决策投影与现有文件按需读取

2026-10-15。基于 origin/main `c38de6c445b37b7d3a390e969e414033dfe3d2c8`，隔离分支 `fix/172-context-projection`。未提交、推送、建 PR、合并、部署或修改 Issue；未改 dsh-bytebase-mcp。

## 实现及保留边界

- 操作详情仅展开 unknown 和本轮关联操作；普通操作计数，blockers 保留所有未决操作的稳定 ID。unknown 身份、状态、资源、授权/证据绑定始终可发现，25 个 unknown 也不截断、不改成功。
- 相同阶段通知逐字段核对后指向执行中的唯一 stageProgress；不同版本或旧报告仍保留原 reportRef。
- 当前目标、控制、版本、作者、来源、更正链及当前结果绑定保持可见。运行中、未排空、本轮关联及未明确历史的当前结果保留；历史目标和完整结果进入唯一 catalogRef。resultInCatalog 指向 `/executions/<原ID>/result`，requestIdentityInCatalog 指向 `/sources/<原ID>/requestIdentity`。原审计记录不改。
- 统一目录保留 `/task`、`/sources/<原ID>`、`/executions/<原ID>`、`/operations/<原ID>`、`/materials`、`/wakes`。历史目标可直达 `/executions/<原ID>/input/objective`；JSON Pointer 段中的 ~ 和 / 按既有规则转义。来源窗口外仍能通过完整目录定位，不能由时间或 wake 名字推断授权已读。
- **取消 eager contentIndex 正文回灌。** 复用现有不可变内容 JSON 文件，长文本返回路径、格式和稳定 contentRef；大批短 requirements、证据、结果、上下文、诊断和日志集合也延迟读取。长配置职责/执行说明使用同一文件机制，内置核心规则不变。生成的执行提示不再重复插入结构化目标。
- 来源长正文复用现有 material JSON 快照，并以同 basename `.txt` 保存原始 UTF-8，沿用原子发布、路径归属、symlink 拒绝和字节一致性校验。目标/要求恰与来源相同时复用 sourceId/textFile，不另造正文。作者、来源版本、身份、附件关联和原 JSON 快照保留；重启复用同一文件。
- readRequired 表示决策需核对相关内容，使用既有原生文件工具定位相关段落及授权边界，**不强制整文件分页回灌**。通用 JSON 文件中的字符串是 JSON 编码；显式兼容 model_content_read 仍直接输出所选正文，可用既有 JSON Pointer 读取精确叶子。无新工具白名单、权限、短 ID、配置协议或人工阻塞。

覆盖入口：taskModelInput、executionModelInput、共享 project/render/wrapOutput 与所属读取工具、群职责提示和动态执行提示。没有拦截无关原生工具或插件。

## UTF-8 结构统计

全部为匿名合成输入，保持结构与规模；不是现场 28413-byte Host 重放，更不能用原审计输入、附件、Markdown URL 或真实工具历史代替模型请求。统计 JSON.stringify 后 UTF-8 bytes，非 token 或完整 provider 收益。绝对路径长度会影响少量字节。

`node scripts/measure-model-context-172.mjs` 的最终代码结果（原始数据见 file-host-measurements.jsonl）：

| 同一匿名样本 | main | 当前 |
| --- | ---: | ---: |
| 当前 Host JSON | 16139 | **2510** |
| operations | 3388 | 274 |
| blockers | 4049 | 266 |
| 阶段摘要出现次数 | 2 | 1 |
| contentRef 出现次数 | 29 | 1 |

样本包含7操作（6 starting、1 unknown）、3历史目标共3132 bytes、活跃执行、阶段通知及授权更正。历史目标不再默认展开，正文全部可读。当前较 main 少13629 bytes（84.5%）。独立复核使用不同临时路径得到2507；三轮真实SDK投影得到2533，均无旧 Host 累积。

## 真实 SDK：同一判断及必要读取

真实 TaskSessions/AgentLoop/ToolRuntime/JSONL，脚本模型、隔离临时库，不连接真实模型或业务。默认六场景的 main 对照与当前结果见 file-decision-measurements.jsonl；脚本 `node scripts/measure-task-decisions-172.mjs` 可复现。

累计值逐请求相加当前 Host 与当次保留的全部工具文本，包含工具历史重传；SDK messages JSON 另存原始数据，不含工具 schema。

| 判断 | main Host → 当前 | 读取次数（均相同） | main累计 → 当前累计 Host+工具文本 |
| --- | ---: | ---: | ---: |
| 首次进入 | 15468 → 2445 | 0 | 15468 → 2445 |
| 阶段进展 | 16041 → 2437 | 0 | 16041 → 2437 |
| 定时巡查 | 15518 → 2495 | 1 | 31265 → 5219 |
| 新消息/授权更正 | 15471 → 2448 | 0 | 15471 → 2448 |
| unknown 调查 | 15481 → 2458 | 1 | 31722 → 5885 |
| 会话恢复评估 | 16510 → 2683 | 1 | 33538 → 6107 |

巡查读取实际执行进度；unknown 仅读原操作参数叶子；恢复仅读原 provider 错误。没有把整个目录变成必读链。

另一个真实原生 file-read 集成使用 **4682-byte、36条不同事实和末尾授权边界** 的人工消息：初始 Host2115；两次仅读相关行及最后边界，工具文本合计901，三个请求累计7882。关闭重开并追加授权更正后，同一来源文件/身份/版本及字节不变；新 Host3019，保留工具文本935，该次判断累计3954。全部正文与原始 Web requestIdentity 仍可从原目录读取。

### 历史诊断与剩余成本

legacy-pagination-decision-measurements*.jsonl 是之前强制全文分页方案的历史数据，**不代表当前方案**。旧压力消息为同一句重复1200次、54000 bytes 的人工构造，既非现场原文，也非正常新消息样本；已从默认六场景移除。旧方案 Host2365、两页工具正文48000/6000、包装437/440；累计110409相对旧59736增加50673，其中48000是第一页在第三次请求重传，1314为累计包装，1359为净 Host 开销。保留此诊断以说明为何取消强制全文分页。

文件读取后，实际选取的正文仍会进入原生工具历史并重传；文件方案不消除历史。大量必要身份、活跃任务、授权更正可能超过3KB，不硬截断。通用 JSON 文件可能是长单行，原生 read 存在行长/总量限制；截断不等于完整读取，需既有 shell/JSON 能力或兼容 JSON Pointer 精确读取。本环境 SDK shell 因缺少 sandbox backend 未跑通，未放宽权限；原生 file read 已实跑。原生读取不会逐次执行兼容 reader 的哈希校验，不能声称防篡改保证完全相同。

## 验证证据与限制

- 投影单测14项：七操作重复、unknown25条、当前/历史目标、版本不匹配阶段、来源/授权更正、窗口外定位、转义引用、显式正文直出、内容文件复用、长文本/集合/配置说明、篡改及外会话拒绝。
- 真实SDK投影1项（三轮 Host 唯一）及六判断场景；原生文件集成1项（相关段落、末尾边界、重启更正、原文身份完整）。
- material-history15项：附件/图片关联、快照错误、路径/symlink/篡改防护；group-coordinator29项：共享投影、原文读取及重开。
- owner/progress/stage定向11项：32轮续办、180旧快照退休、旧证据按需读取、阶段证据和绑定版本、恢复及真实巡查。动态执行32轮与升级旧快照2项通过，旧快照收益未计入本次结构收益。
- 独立只读审查复现14项及2507-byte投影；其指出的大量短 requirements 延迟投影被覆盖问题已修正并补测。审查未配置临时 native profile，原生证据引用本代理实跑，不冒称独立复现。

临时 profile 缺少 dsh-fs peer 的问题在未改 main 同样复现；仅在 `/tmp/issue172-profile` 补齐同版依赖，使用 `DSH_NATIVE_TEST_PROFILE=/tmp/issue172-profile/package.json`，未改仓库依赖配置。所有验证只用合成消息、临时库和脚本模型，未接 resident/钉钉/业务库，未发送真实模型请求。未部署，不能声称现场已修复。

最终合并定向命令（设置上述临时 profile）：node --test test/model-context.test.js test/model-context-172-native.test.js test/model-context-172-decisions.test.js test/model-context-files-native.test.js test/task-session-material-history.test.js，37通过、0失败、0跳过。最终修改模块 node --check 及 git diff --check 通过。一次命令外层引号导致 profile 环境变量未设置的运行失败，修正命令后以上完整实跑通过。


## 2026-10-17：最终 Host 整体预算补修（未提交）

基于 main `5732e4b`。上文 2510-byte 结论仅适用于其特定合成样本；字段 512/2048 阈值不能保证最终 Host 整体预算。用户提供的匿名现场最终 Host 统计为统筹6973、执行续办9433、独立回读10425 bytes；本云端未取得业务原样本，下面压力结构结果仍是合成；百部本地实际历史输入的离线转换结果见末节，不混作云端合成测试或部署后现场验收。

窄方案及自审：保持已有 task/execution/source 决策投影，最后统一测量 JSON.stringify 后 UTF-8 字节。小于等于3000保持原视图；超过时把完整预算前投影保存为既有准入不可变内容文件，公共 contextRef 加各字段 contextPath（JSON Pointer）承接最大的字段，目标2800、硬上限3000。极端长键/大量键或保留键冲突时仅保留公共快照引用。字段正文、长指令、作者/版本/授权更正、未决要求、unknown效果、恢复状态和目录均无损保存在快照/既有原目录，不拒绝合法输入，不修改审计记录，不吞读取错误。readRequired 明确未读边界，使用已有 model_content_read 的 contentRef/path 参数继续定位；显式读取仍返回正文，不要求整包读回。

三类最终 Host 入口接入同一预算；普通工具 render/wrapOutput 同样有预算，保持原有 reuseVisible 去重；显式 content reader 不二次包装。群历史退休保持预算前来源签名，超预算历史从准入快照恢复来源后退休，空闲派生也接入。未改变权限/工具白名单、UI、工作流或部署。

匿名压力结构（非业务原文）：5/100来源，长中文ID、emoji、长目标及指令、版本/人工更正/quote、当前及旧结果、nonempty blockers/unknown operations。以下同一个输入预算前/后，字节仅统计最终 Host JSON文本：

| 结构 | 来源数 | 预算前 | 最终 |
| --- | ---: | ---: | ---: |
| 统筹 | 5 | 7440 | 1356 |
| 执行 | 5 | 11189 | 2427 |
| 常驻 | 5 | 8416 | 2371 |
| 统筹 | 100 | 19965 | 2062 |
| 执行 | 100 | 52256 | 2427 |
| 常驻 | 100 | 122112 | 2371 |

这些数字来自 model-context.test.js；路径长度会影响预算前字节。逐字段回读与完整快照比较，确认正文和来源身份完整；另测转义键、200个长键、超长目录路径、保留字段名冲突及普通工具旁路。工具读取后的历史仍可增长，不把真实证据历史视作可删除内容。

最终命令（PowerShell 7）：

```powershell
node --test test/model-context.test.js test/model-context-172-native.test.js test/model-context-172-decisions.test.js test/group-coordinator-session-native.test.js test/dynamic-execution-session-native.test.js
```

75通过、0失败、0跳过。真实 SDK/AgentLoop/ToolRuntime/JSONL，只有 LlmAdapter 为脚本：新增超预算统筹3轮最终文本均2505 bytes，并通过真实 model_content_read 读取第5作者叶子；执行同库跨宿主重开3轮均2404并回读第5来源版本；群4轮621/621/621/398，最后空来源仍保留5条历史来源，每轮仅1完整当前Host。既有32轮执行续办、旧递归Host升级退休、群32轮重复/空来源、unknown调查及恢复路径继续通过。系统/schema与全部SDK消息/adapter request另有统计，以上绝不表示完整模型上下文或provider请求<=3KB。

独立只读审查先发现工具重复读取去重、群来源签名以及超预算历史退休三项问题；均修复。审查者独立运行投影/群测试46通过，并单独复核新增群4轮用例通过，未发现剩余阻塞。之后新增执行重开压力测试包含在上述75项实跑中。

环境历史：首次冻结安装未成功，详见下节；首次材料/文件组合25通过、12失败、1跳过的结果已被正确配置隔离profile后的验证取代。未运行全量测试、未接真实模型、未读取业务库/日志、未部署或发布、未关闭issue；群修复后的现场常驻角色仍无证据。三份原任务历史输入已由既有百部只读会话在本地完成离线转换（见末节），本云端未接管业务。


### 隔离 profile 补齐与安装状态

仓库2.0.0已提供受支持的private workspace `test/fixtures/native-profile/package.json`，由 `pnpm-workspace.yaml`/锁文件纳入冻结安装；`.github/workflows/ci.yml`和`docs/ops/npm-release.md`规定显式设置变量及预检。前次不是仓库缺这套依赖，而是本次测试遗漏变量，默认查找不存在的`.dsh/profiles/resident/package.json`，首先resolve失败的是`@deepseek-ai/dsh-base@0.2.1-alpha.2`，不是12种独立生产故障。

12个失败分别是：active task ignores archive；source/attachment materialization；resource throw/null/partial/metadata-only/unconfigured共5项；cached material snapshot-link/snapshot-truncated/foreign-resource/resource-link/source-identity共5项，均在nativeTaskHost可用性检查前失败。file-native另1项因此skip。未绕过策略或改变依赖版本，使用已有安装模块设置隔离profile后，37模块预检通过：

```powershell
$env:DSH_NATIVE_TEST_PROFILE=(Resolve-Path test/fixtures/native-profile/package.json).Path
node scripts/verify-native-test-profile.mjs
node --test test/model-context.test.js test/model-context-172-native.test.js test/model-context-172-decisions.test.js test/model-context-files-native.test.js test/task-session-material-history.test.js test/group-coordinator-session-native.test.js test/dynamic-execution-session-native.test.js
```

最终91通过、0失败、0跳过。切换profile后发现旧测试假设sources/materials必为数组的两项失败，已适配引用协议并保留原断言：来源测试真实调用model_content_read读取元数据和textFile，再用原生read定位正文；材料测试仅测试侧用content index解引用后核对全部材料，不宣称模型调用读取材料。独立复核这两文件16/16通过。来源文件4682-byte原文，重启前/更正后Host2115/2068 bytes，工具文本901/3331；每请求累计Host+全部工具文本7882/12983（包括新增两次目录发现，不能漏算后称5399）。

冻结安装失败的精确命令为：

```powershell
$env:PNPM_HOME="/tmp/issue172-pnpm"
$env:XDG_DATA_HOME="/tmp/issue172-data"
$env:XDG_CACHE_HOME="/tmp/issue172-cache"
pnpm install --frozen-lockfile --store-dir /tmp/issue172-store
```

返回`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`：515个lockfile entries中2个不满足cutoff `2026-10-16T03:39:48.161Z`；`@deepseek-ai/cordis-plugin-timer@1.1.7`发布时间`2026-10-16T13:39:24.854Z`，`@deepseek-ai/cosmokit@1.8.6`发布时间`2026-10-16T13:38:59.209Z`。pnpm在最后政策检查前已下载/链接456包，因此已有模块可用于上述测试；不能将这些测试通过描述为一次干净冻结安装已通过。没有重试拒绝的安装、放宽minimumReleaseAge、修改安全配置或重建lockfile。最初默认store目录mkdir失败与上述政策拒绝是两件事。当前唯一安装限制仍是干净安装的年龄政策，非模块预检/测试缺失。

### 原现场离线回放与最小脱敏证据

新增`scripts/replay-host-budget-172.mjs`只读本地JSON封装：`{kind:"task"|"execution"|"group",input:<原始Host对象>,binding:{executionId:<原ID>},originalHostTextBytes:<可选原最终文本字节>}`。应由既有只读会话从rawHostMessageId对应原审计输入提取，执行续办及独立回读分别提供一份；不要把投影后的Host再当原始input。脚本不调用服务/业务库/工具/模型，不读取原material路径，只在新建隔离临时目录生成内容文件，重建content index后逐引用、逐pointer及完整预算前快照校验，最终清理临时目录。命令：

```powershell
node scripts/replay-host-budget-172.mjs <仅百部本机的封装JSON路径>
```

仅带回脚本输出的kind、字节、引用数量及布尔校验结论。`isolatedProjectionBeforeBytes`含隔离临时路径成本，不等于现场原基线；`originalHostTextBytes`须由本地实际最终消息所有text块UTF-8之和提供。正常脚本输出不含正文、ID、路径或hash；失败日志需本地脱敏后再分享。脚本在当前依赖环境的三类合成fixture已实跑，业务调用0；绝不据此声称三份原现场已回放。脚本只校验本次生成的引用，不验证input已有外部引用文件的存在/hash；原现场16文件完整性仍应由既有只读本地校验单独证明。离线转换只需已安装仓库Node依赖，不需完整native profile。

若需要云端等价结构fixture，最小数据为：字段/数组形状、来源/执行/操作数量；所有字符串JSON转义后UTF-8长度及相等关系（目标与source.text的复用不能改变）；状态/版本/控制及需求修订、current/drained/recovering等布尔、unknown/blocker成员、授权作者与corrects/supersedes关系；ID/path的长度及~ /和转义形状；长文本/quote/requestIdentity/结果/恢复诊断的长度与嵌套。用一致的假ID/假作者替换并保持关联；用同宽中文/ASCII/emoji和相同换行/引号/反斜杠分布生成假正文，校验序列化字节等长，不能带业务正文、原ID/路径/账号或凭据。多轮群与执行复现另需原始来源版本变化、inputHistory/binding关联；文件内容只生成本地匿名快照并重算hash，不上传原文件。若无法可靠保持这些结构，只回传本地测量结果，不勉强上传原输入。现有脚本是单轮离线转换/引用校验；多轮真实SDK退休、读取和恢复另由上述定向用例验证，不能混称原现场完整surface重放。


### 百部实际历史输入离线验收（2026-10-17 03:55 UTC）

证据来源：百部只读会话thread `01a147e2-9230-75c8-9f2d-465ddcf9e03b`于03:55 UTC回报，经父线程传入本开发会话；本云端仅记录匿名指标，未接收业务原文。代码包`hiq-issue172-offline-replay.zip`为15802字节，SHA256 `3caae5841ce3dfe8413bc9f83c17a5e9518b008c800cb77076f5f994e025358a`，百部确认包hash及六项文件清单校验通过。

百部使用完整原始inbox输入，不是已压缩投影；两个执行样本binding使用原生日志中的executionId。原最终消息及本次转换后消息均按UTF-8文本字节统计：

| 实际历史输入 | 原最终Host | 离线转换后最终Host |
| --- | ---: | ---: |
| 任务统筹 | 6973 | 2091 |
| 执行续办 | 9433 | 2284 |
| 独立回读 | 10425 | 2433 |

三份均<=3000字节。重开content index、完整快照还原、JSON Pointer精确还原及新引用递归读取均通过；原16个引用文件hash仍有效。业务原文未出百部，无部署、重启、模型调用或业务调用。

此项证明实际历史原始输入在同哈希代码下可离线转换且引用完整；不等于部署后真实Host请求验证，也不等于群聊修复后常驻角色现场验收。系统/schema、工具历史和完整provider请求不在上述3KB统计内。云端91项定向测试和37模块预检仍为独立合成/SDK证据；干净冻结安装仍保留前述发布年龄策略限制，未因本次离线成功变成安装通过。
