# Issue #172：Host 上下文增长修复验证

最终基线：远端 main `4d2b8e3006b4d083591d68c47c2258f94e485643`（#173），分支 `fix/172-session-context-growth`。启动时检出为 `85d7039`（#171）；交付前已快进到新 main。#173 未修改本次涉及的运行时源码和测试，未执行其迁移脚本。
仅修改主仓库；没有修改运行实例、已有业务会话日志或会话中的仓库副本，没有部署、重启、推送或业务操作。

## 根因与修复边界

1. `task.blockers.executions` 原先返回完整账本对象。现在与顶层 executions、previousExecutions、execution-read 共用 `execution-context.js` 的投影；保留身份、版本、当前目标、当前结果、恢复标记，排除完整输入、旧输入和历史 results。账本仍保存原始对象。operations/legacy blocker 不作截断，未知效果、资源锁及对账证据保留。
2. 动态执行会话在首次 `agent/request` 阶段逐节点替换旧 Host 输入，兼容升级前已经存入的递归 v1/v2/v3 输入。只处理同 sessionId、coordinator 来源的 executionSession 输入，独立用户消息与 assistant/tool 证据保持。当前完整输入随后由原生 inbox 正常进入 surface。
3. 群会话对历史来源按 sourceKey、正整数 sourceVersion 和完整证据内容去重（仅忽略顶层 runId）。当前来源优先；不同版本、发言者、正文、引用、附件、授权/未知字段仍独立保留。缺少可靠身份的来源不去重，跨群节点不处理。也覆盖 dynamic 路径和升级前的 history。历史来源为空时退出模型消息。

这不是通用历史压缩：唯一真实来源、工具调用/结果和模型输出仍可能增长。统筹现有的小型替代标记仍按轮数增长，不再回灌完整执行记录。没有改工具授权名单或引入新的业务授权。

## SDK 0.2.1-alpha.2 持久化验证

- 使用真实 Session、AgentLoop、LlmRuntime、Tools、JSONL 后端；只有模型 adapter 是脚本。统计到脚本 adapter 收到的请求，不代表真实 provider wire body。
- `surfaceOp: { op: 'replace', startSeq, endSeq }` 单点替换；`sourceEventSeqs` 引用原事件，原始 append 事件未改写。
- 空 `developer/message` 由 `deriveEventMessage` 投影为 null。必须使用 producer-owned source，并在已打开的 turn/step 内写入。试验已经发现：空闲阶段写入会导致重开时拒绝。因此实现使用公开 `agent/request` 阶段，不在 idle 中写 developer tombstone。
- 32 次执行续办每轮关闭宿主再重开，持久化事件用 `foldSurface` + `deriveEventMessage` 重放。升级测试逐事件核对原审计前缀相等。
- 群工作区空闲迁移仍可保存非空来源 history；需要空节点替换时推迟到实际下一次请求。

## 失败回归与增长预算

修复前实际运行三个新增回归：blocker 包含 previousExecutions；执行第二轮可见两个完整 Host 输入；群聊第二次相同来源唤醒可见两份来源。三个断言均失败，随后实现修复。

覆盖包括：32 次同执行身份续办、活 blocker、旧递归输入升级、同来源重复唤醒和空来源、恢复中的 blocker、当前结果与历史结果分离、execution-read 工具结果旁路、原生 job 恢复、独立来源版本/发言者/授权及附件边界、无法确定身份的来源、跨群边界、原生持久化和真实 npm tarball。

预算为合成 fixture 的回归断言，不是产品级硬截断：

- 统筹：当前 Host 输入 <60,000 字节；32 轮后相对首轮增长 <6,000 字节；旧标记等额外 Host 消息开销 <33×750 字节。
- 执行：精简输入开始后每轮 Host 消息 <1,500 字节；第5至32轮完整消息增长 <27×550 字节，保留实际结果历史。
- 群聊：32轮 Host 消息比首轮增长 <1,000 字节；空唤醒后完整消息增长 <25×700 字节，同一来源始终一份，空历史零份。常规和 dynamic 模式都验证。

## 字节结果

以下均为 UTF-8 JSON 字节，不是 token。前后比较来自同一匿名合成 fixture 的真实对象/原生日志投影，不是 issue 中的业务样本，也不是日志文件大小。

|范围|修复前/升级前|修复后|
|---|---:|---:|
|统筹活 blocker executions 数组（原账本完整对象 → 查询投影）|26,818|444|
|执行升级：三份已存递归 Host 消息数组 → 当前 Host 消息数组|193,198|448|
|群升级：177个旧 history 消息 → 10个必要 history 消息，含独立边界|70,328|4,951|

群升级 fixture 含71份重复来源、97个空块、不同版本/身份/正文/附件/授权的证据、两个无可靠身份的来源和一个跨群节点。后者全部保留，故不应收敛为单一来源。

32轮修复后增长结果：

|角色/轮次|当前输入文本|Host 消息数组|全部模型消息数组|脚本 adapter 请求 JSON|
|---|---:|---:|---:|---:|
|统筹，首次|35,026|35,612|40,265|54,284|
|统筹，第5次续办最终读取后|36,180|39,701|98,288|112,307|
|统筹，第32次续办最终读取后|36,191|54,852|405,475|419,494|
|执行，v1（旧式大输入）|48,274|48,605|49,934|50,984|
|执行，v5|215|536|3,765|4,815|
|执行，v32|216|540|16,616|17,666|
|群，首次|未单列|12,407|18,891|19,948|
|群，第32轮|未单列|12,687|38,398|39,455|

统筹 fixture 有意在每次 task_delegate 工具调用中发送约7.5KB授权 context，完整消息仍随真实工具调用与结果增长；没有把这个必要历史说成已消失。表中 Host 消息包含 source/id 元数据；全部模型消息包含系统消息和工具结果；adapter 请求额外包含工具 schema/config 等。真实 provider 转换、实际 usage/token、业务原会话现场读回均未取得，不作数值推断。

## 命令与结果

所有命令在 PowerShell 7.6.5、Node 24.19.0 下执行。项目依赖使用锁文件安装，store 放在 `/workspace/.pnpm-store`。原生 profile 在 `/tmp/issue172-native-profile` 独立安装，合并项目锁定的 devDependencies 补齐 peer；未修改持久环境设置。

```powershell
$env:DSH_NATIVE_TEST_PROFILE='/tmp/issue172-native-profile/package.json'
node --test test/dynamic-task-store.test.js test/dynamic-execution-session-native.test.js test/group-coordinator-session-native.test.js test/dsh-alpha2-session-compatibility.test.js test/task-session-service-native.test.js test/task-session-job-recovery-native.test.js test/task-session-listener-resume-native.test.js test/task-session-package-native.test.js test/task-session-provider-native.test.js test/task-session-progress-native.test.js test/execution-session-native.test.js test/session-persistence.test.js
git diff --check
```

扩大回归：221项，217通过、4失败、0跳过。两个进度读取测试报 `EXECUTION_PROGRESS_INPUT_MISMATCH`（持久化读回 inputs=[]）；两个旧 no-submission 恢复测试读取 lastDecision.action 时 lastDecision 不存在。

在未修改的 `85d7039` 独立 worktree 用相同 profile 执行：

```powershell
node --test test/task-session-provider-native.test.js test/task-session-progress-native.test.js
```

基线9项：5通过、相同4项失败。因此这些失败不是本补丁引入；本次没有扩展到其修复，也不声称扩大回归全绿。与本修复相关的8文件组合（上述命令排除 provider、progress、旧 execution、session-persistence 四文件）最终重跑116项全通过、0跳过，包含32轮统筹/执行/群聊、恢复 blocker 和边界断言。

## 独立审查

重新从 diff 检查，而不是依赖测试结论：来源版本/身份不合并、未知字段与 context 授权保留；跨群节点与独立用户消息不替换；operations/legacy/工具证据不截断；原始事件不修改；replacement 的生命周期满足 SDK JSONL 重开约束。发现新增模块需加入 package.json 的 files 白名单，已经补齐，并实跑提取 tarball 后的原生任务。

未验证：真实钉钉消息、生产/本机原业务会话、真实 provider token/计费、实际重启及重启后通知。云环境没有目标运行实例；本地提交可供审查，尚未推送或部署。
