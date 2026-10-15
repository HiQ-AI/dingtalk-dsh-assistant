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
