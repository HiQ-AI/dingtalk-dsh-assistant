# Issue #172 补充修复：有索引的模型输入

本轮依据两条重开评论，尤其 [6170768924](https://github.com/HiQ-AI/dingtalk-dsh-assistant/issues/172#issuecomment-6170768924)。基线 main：`1f10eea10aa26a1afc2e08ec9d0d842925b38bd8`；工作分支 `fix/172-indexed-model-context`。未提交、推送、创建 PR、合并、部署或关闭 issue。

本记录区分云端代码回归与现场验收。最新协议使用json-index字段目录，避免通用JSON读取再次序列化完整正文；原生分页读取与宿主重开已实跑。测试结果及未验证边界见下文，不代表业务实例已部署或重启。

## 已确认问题及边界

#174 的执行旧快照替换和 blocker execution 投影已经生效。本轮处理当前输入内部及模型读工具的重复，不把原始审计大小冒充模型上下文，也不把旧修复说成完全无效。

- task/source/material/Web requestIdentity/人工答复反复展开同一正文。
- execution 摘要仍携带完整 result；previousExecutions 全集还重复续办自身的结果。
- 所有非 succeeded 操作含终结 failed 都展开 definition/result；未知 blocker/reconcile 亦会回灌完整对象。
- 群聊正文、职责、嵌套引用在不同来源和四种读工具之间重复；整个 source 签名不能消除这些重复。

## 模型协议与持久化

`model-context.js` 仅用于模型边界。正文/目标/答复等内容字段（包括短正文）及长文本使用 `contentRef`，`contentIndex` 在当前输入内定义内容一次。作者、来源 ID/版本、更正关系、授权身份仍留在各自记录中；相同正文不合并不同作者或版本。重复的大型嵌套记录亦使用引用，字段顺序不影响摘要。

`model_content_read` 仅能读取本会话及受信继承会话的内容，支持 JSON Pointer、offset/limit 和 nextOffset。对象/数组返回json-index目录，每页最多20个条目，大字段返回valueRef；文本按UTF-16字符分页。目录只列前20项，但 catalogRef 保存所有记录，可按ID直接读取；没有截掉未处理要求或证据。普通读工具首次提供必要内容，重复读回可以返回可解析引用。显式 model_content_read 是索引读取的叶节点，每次均返回请求页的字面正文，包括当前已可见或重复读取的内容；不再次投影为引用，也不以 alreadyVisible 省略正文。bytes字段为规范JSON的UTF-8字节（字符串包括JSON引号和转义），不是token计数。

内容文件位于原生会话工作目录下 `.dsh/model-content/<会话范围>/`；无 cwd 的会话使用进程工作目录。引用包含会话范围和 SHA256，文件独占创建、校验摘要、拒绝符号链接，写入和目录同步后才发布引用。组会话受管派生记录父范围和内容根，子会话可继续读取父引用。正常宿主关闭/重开已验证。此目录是新增的持久数据，必须与会话一同保留；缺失/损坏会明确报错，不编造内容或绕过校验。没有清理已有业务会话或修改本机业务数据。

原始 steer 仍先由 SDK `agent/inbox/spliced` 原样记录。公开的 `agent/pre-step` 只对同会话 coordinator 消息作模型投影，使用新消息 ID 并通过 rawHostMessageId 链接原始输入；独立用户消息不改写。账本、原始来源/材料文件、既有审计事件均不变。SDK surface 重放看到的是投影；原始 inbox 审计保留完整内容。

任务模型使用任务简要状态、最新/未答人工请求、来源/材料目录和完整任务引用。终结 failed 操作只进入历史目录；未终结操作和 unknown 保留状态、资源、授权/证据身份及完整证据引用。执行模型直接携带授权来源及最后一条原需求者更正，其他来源按当前小目标沿目录读取；历史执行为有界目录，排除自身执行ID，完整他人结果和材料仍可读取。

## 逐条覆盖

|补充要求|覆盖及证据|
|---|---|
|Web requestIdentity / request / source / material 重复|真实原生统筹失败回归：正文9份→1份；原账本 Web identity 仍等于原文|
|多来源，同正文不同作者/版本|model-context：不同作者、版本各自保留，正文定义共用；引用逐字读回|
|人工答复、授权更正、未处理要求|人工答复与来源/材料共享内容；corrects、responseSourceId及完整任务记录可读取；原有人工补充原生流程通过|
|短正文|单独回归短授权正文，不依赖120字符阈值避开去重|
|材料及引用|textRef/quoteRef和来源目录都可解析；原材料及资源文件写入逻辑不变|
|执行数/result长度/failed数增长|1、20、120项组合增长；目录始终≤20条，完整最后一项结果、failed证据均按ID逐字读取|
|续办自身结果与其他执行全集|模型目录排除自身；自身真实工具/提交历史保留；所有其他执行记录均在完整目录中，32次续办和显式结果读取通过|
|unknown blocker / reconcile|区分 terminal failed 与 unknown；状态、资源锁、授权/证据身份和原对象都可读取；原生 job 对账/恢复回归通过|
|群 body/context.source.text、policy、嵌套引用|正文/职责唯一内容；不同引用边/作者不丢；2、5、9层重复图增长断言|
|read_tasks / read_history / read_material / read_task|统一原生 readTools 输出投影；四类工具首次新证据、第二次引用、model_content_read及宿主重开均实跑|
|目录与全文分页|真实SDK读取20,490字符的此前未见正文，逐页拼回完全一致；作者、来源版本、更正关系及嵌套引用独立可读，宿主重开后仍可解析|
|原始审计|实际 SDK 输入链接原始 inbox ID，原始内容不变；升级前事件前缀一致；没有重写历史日志|
|SDK v4迁移错误|坏 assistant.sourceEventSeqs fixture 原样被 SDK 拒绝；0模型请求、日志字节未改写，未绕过校验|
|Observer/并行进度契约|taskDTO/taskDetail/taskExecutions、账本状态机、DB schema均未改；原生测试核对原始 completion 和 request；复用既有lastDecision与版本时间，不新增progress存储|

## 测量范围与匿名字节

全部为 UTF-8 JSON字节。真实原生 Loop/Tools/Session/JSONL，模型 adapter 为脚本；不是实际 provider token、计费或 wire body。下表前两行是相同 fixture 的最新 main 与补丁实跑对照，其余为明确标注的投影增长实验，不是原业务现场。

|样本/统计范围|前|后|
|---|---:|---:|
|原生 Web 统筹当前 Host 消息数组|27,979（正文9份）|8,879（正文1份）|
|同次原生脚本 adapter 请求 JSON|47,766|30,289|
|20执行/failed组合的当前 owner 投影 JSON|645,711|15,296|
|120执行/failed组合的当前 owner 投影 JSON|23,072,071|15,302|
|9层群聊嵌套来源图的当前投影 JSON|23,702,160|16,675|

单个小记录样本为2,341→3,487字节，索引/能力引用有固定开销；没有声称任何输入都变小。20→120记录时执行投影13,034→13,659字节，结果正文不会全量注入。短目标也有唯一内容定义，增长预算包括这部分开销。

实际原生32轮执行样本：原始审计输入v1为48,342字节，模型当前输入约1.8KB；v32审计输入284字节，模型当前输入约1.8KB（目录固定开销）。旧 Host 完整输入仍只有当前一份，真实工具/模型结果历史保留，未据审计累计153,256字节声称当前模型请求这么大。

实际原生统筹32次续办：当前输入13,288→15,177字节；完整 adapter 请求最终523,742字节，含真实委派参数、按需证据读取的工具历史和本 fixture 每轮主动传入的长 context，不能称作已经消失。实际群读工具样本分别统计当前 Host、旧 Host、工具历史、system 和 schema；首次必要证据使工具历史增长，重复调用不再重复正文。全文分页样本工具历史2→78,658字节，adapter 8,445→98,391字节；这是主动读取完整新正文及目录/回执的成本。详细分项由测试诊断输出。

## 验证命令与结果

PowerShell 7.6.5、Node24，原生 profile 为 `/tmp/issue172-native-profile/package.json`，仅进程内设置测试变量，没有持久修改环境。

```powershell
$env:DSH_NATIVE_TEST_PROFILE='/tmp/issue172-native-profile/package.json'
node --test test/model-context.test.js test/task-session-service-native.test.js test/task-session-job-recovery-native.test.js test/task-session-listener-resume-native.test.js test/task-session-package-native.test.js test/dynamic-task-store.test.js test/dsh-alpha2-session-compatibility.test.js test/task-session-http-integration.test.js test/task-session-observability.test.js test/group-coordinator-session-native.test.js test/dynamic-execution-session-native.test.js test/task-session-persistence-native.test.js
git diff --check
```

最新上述12文件相关回归148项，148通过、0失败、0跳过（约30.6秒），日志 `/tmp/issue172-round2-final-green.log`；`git diff --check`通过。原生json-index分页测试包含在这次运行中。

另外实跑 `node --test test/task-session-progress-native.test.js test/task-session-provider-native.test.js`：9项中5通过、4失败、0跳过，日志 `/tmp/issue172-round2-final-extended.log`。未修改的最新main独立检出实跑也是相同4项失败，日志 `/tmp/issue172-round2-baseline-existing.log`。两项为 EXECUTION_PROGRESS_INPUT_MISMATCH，另两项为旧 no-submission 测试 lastDecision 不存在。本轮不混入另行处理的provider/background恢复机制修复。两组共157项、153通过、4项基线已有失败，不能称为全部回归通过。

失败优先证据保存在 `/tmp/issue172-round2-red.log`：将新回归放到未改生产代码的main检出后，统筹正文实际9份、群聊正文实际12份，均未满足唯一正文断言；同用例在最终补丁通过。

## 独立 diff 审查及限制

审查重点：投影不调用 store.command，不改变执行派发载荷/摘要/控制状态/完成条件；Observer API仍读原始账；既有lastDecision及版本时间可读取；独立用户来源不投影；同正文不继承他人授权；unknown不因展示变成终结态；所有省略字段都有不可变、可校验引用；原始 inbox/旧审计不修改；SDK迁移拒绝保持；发布 files 白名单包含新模块。

未验证原任务安装包版本、进程实际加载版本、真实钉钉输入、原业务会话 surface/provider请求或实际 token。常驻迁移日志的 SDK 错误仍是现场验收阻塞；本轮只证明云端代码与合成/原生测试，不宣称现场闭环，不部署、不唤醒业务、不关闭 issue。另一个进度/UI任务及provider恢复任务应在后续集成时协调同文件改动。
