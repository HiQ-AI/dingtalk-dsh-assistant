# 2.3.0 发行测试恢复

失败基线为 `fa14be0f5f571d0740081c65da372c5456220545`，Release run `41090776423`。六组共 4247 项：3778 通过、424 失败、33 取消、12 跳过；build/publish 未运行。原 `v2.3.0` 的 annotated tag 对象是 `8ff676edd1ef292cc21da6b332050191b00ab7d0`。原失败日志保留，不用测试数量变化推算通过率。

用户要求修复现行契约及真实缺陷，仍发布 2.3.0。这里不恢复已退役的独立协调引擎，不引入后续防漂移方案，不部署实例。当前 Task Owner、Topic、原生平台定时和共享通知是验证对象。

## 保留的保证与已经退出的算法

旧跨 Task DAG、周期 task-command、安排重排和旧 planner 的重试预算已经退出装配。它们不能被描述为当前算法的等价实现。对应测试按原风险分别验证现行 Task 的版本/租约、资源互斥、Topic 来源、通知许可、未知结果只回读、历史保留及不重放。保留纯历史只读格式断言；仍有效的产物权限、完成证据、事务故障窗和跨重启幂等继续使用真实存储/原生接口。不得用重复的 `INDEPENDENT_COORDINATION_RETIRED` 断言替代这些保证。

没有将文件移出 Release、删除历史文件、提高原生超时或放松沙箱及路径检查。新夹具仍由递归映射纳入；最终分类以 `test/suite-map.json` 及合同审查为准。

下表按原失败所属合同列出迁移去向。文件仍保留在原测试目录，不用文件数量或总测试数证明旧算法仍存在。

| 原测试类别 | 当前实际验证 | 明确保留的边界 |
| --- | --- | --- |
| source-dispatch、message-projections、migration | 真实启动退役、来源群/消息/版本与 unit 的精确对应、原审计不变、新版本不能继承旧完成 | 退役结算不是业务完成，不制造 Topic 决策或启动旧工作 |
| concurrency、execution-proof、effective-graph、trigger-commands | Task 的版本/租约、真实资源互斥、执行排空、人答、完成事务与原命令幂等 | 原 DAG、重排和按日/周执行旧 Task 模板不再受支持；历史模板只读且不得重放 |
| ledger、final-fault-matrix | 真实 SQLite 事务故障、COMMIT 回执丢失、子进程 SIGKILL、重启后查原回执 | 未完成事务没有完成事实；未知外部效果只回读，不能再次取得发送许可；杀进程后等 close 再清理库 |
| artifact-correction、archive | 原产物 scope、纠正命令的当前版本授权、终态归档资格 | 不能由旧协调状态授权当前写入，不能用归档移除在途效果 |
| notification-freshness、summary、observed-prerequisites、schedule-revisions、recovery | 当前 Topic 事实版本、冻结通知的内容/受众/附件、精确来源、恢复幂等、历史日程不重放 | 已移除的 freshness timer、旧 planner 重试预算和自动观察续办没有等价算法；脚本时钟测试不充当真实原生定时 |
| observer、node-control-display | 当前 Topic/Task 的有界查询、异步请求归属、展开/分页、真实待办原因与旧记录只读投影 | 原协调管理 UI 不再存在；组件测试不等于浏览器视觉或真实渠道验证 |
| final/observed/fairness/model/workspace/reorder/background 原生用例 | 真 Host、Route/Topic/Owner 工具、原 Task 身份与工作区、受信多人受众、一次持久通知与恢复 | 以明确新输入续办当前 Task；保留旧引用及审计，不假称旧调度已执行 |
| 当前 Task clean-start/human/service/reply-identity/http/handoff | 原始消息与账本保留、仅注册既有两类固定话题、人答与事实来源、共享通知、读回与发送独立进行 | 来源依据不必成为原生引用；已冻结/已送通知不能因恢复而重新拼装或发送 |
| artifact-scope 原生用例 | 执行会话的真实 FS/shell 权限、一个 Task 的三阶段依赖、明确 reopen 后同身份续办 | Owner 不直接获得执行工具；目录外零写、未知操作阻止完成，Linux 缺沙箱不得换全权限冒充通过 |

测试夹具只从关闭的合成 SQLite 库插入匿名旧行，再走真实启动退役。当前命令仍经正式 Store/Host；没有重新开放退役写入口。故障注入针对实际事务或子进程，不把普通 JSON 回执当作外部发送证明。

展开数并非逐文件守恒：`independent-coordination-changes` 从原实际 52 项变为 42 项，退役的 admission、三方 handoff、ordinal/clarification/allTogether、周期及 time/proof join 变体归入上述历史保留与不重放验证，并补充当前 Topic 的 CAS、并发、受众和输入范围断言；不能把减少的 10 项计作修复通过。`coordination-observer` 实跑 68 项，其 HTTP 路径数组的 spread 展开使静态目录计数少 4 项。原 202 注册/220 变体的混合合同守恒另由下一节独立约束，不能混同这些非混合文件的迁移。

## 混合测试的显式复审

固定来源 `7ca36c26ad1c52e8b1896fdc76a7e8aed1c9a697`、202 个原注册、220 个原展开变体及现有 Release/history 分类不变。原语句 SHA256 继续保存并从 Git 原文核对。本次以下变更另外记录 `review`，包含原摘要、现摘要、变更前 commit、具体理由及证据；不能只更新文件摘要绕过注册守恒。

| 原注册或夹具 | 变更 | 保留的断言 |
| --- | --- | --- |
| execution-local-acceptance #20 | LF/CRLF 检出补齐真实传递依赖；用相同平台无关配置构造源码身份，不额外预约 Windows 进程 | LF 与 CRLF 身份相等；真实源码变化后身份不同；三种变体及比较断言原样保留 |
| runtime #101 | 合成 Topic 决策明确提供本例受信接收人 | 已接受 Outbox 落盘前关闭等待、新输入拒绝、最终一次持久回复 |
| runtime #136 | 合成 Topic 决策明确提供本例受信接收人 | 同 Task 重复动作拒绝、两 Task 明确取消各一次、版本/操作数/终态不变 |
| runtime #124 | 历史慢创建用例的合成确认明确指定本例受信作者 | 其他 Topic 独立完成、原 3 秒等待和历史分类不变 |
| runtime-mixed decide/statusReply | 合成模型按本例依据作者声明受众；生产不采用此测试默认值 | 原控制、回执、等待和断言不变；当前 34 项及相关历史内部审阅/短答恢复路径实跑 |

复审不能改变原身份、原分类或变体数。守恒测试继续核对原 Git blob，当前内容必须匹配复审后的精确摘要，并验证缺理由、缺证据、错来源摘要、错当前摘要及分类变化均被拒绝。共享夹具的变更前内容从复审 basis commit 回读后仍与首次拆分的 helper 比较。

## 有界实现及环境修正

- Resident 读取无 topics 的旧群记录时不尝试遍历不存在的字段，旧数据保留。
- 消息列表只投影两个已定义的公开恢复提示代码；原始 Host 错误正文留在决策账，不直接放入消息列表。
- 精确回复来源缺失时查询返回 `null`，由原有 `TOPIC_REPLY_SOURCE_INVALID` 校验拒绝；不再将 `undefined` 送入 JSON 克隆而抛解析错误。缺少正确来源版本或当前 Topic 尚未处理完成时均不落通知。
- 归档交互测试补齐真实页面/AbortController 上下文，SQLite 测试先关闭再清理。
- 生成的设置脚本与现有源码同步，没有页面行为改动。
- PowerShell AST 大脚本通过临时文件调用，保留原断言，避免 Windows 命令长度限制。
- native profile 仅补 `dsh-schedule`、`dsh-tool-schedule` 两个 alpha.2 模块及其锁定依赖；未升级产品依赖。真实定时测试不再因模块缺失跳过。
- 受审查 provider 文件按 pnpm 实际依赖闭包解析；原三个源码摘要不变。测试新建 Windows 目录单独准备当前 SID 的所有权，产品沙箱检查不变。

## 验证边界

本地相关检查与最终 Windows Release 分开记录。Linux 无可用原生沙箱时，真实受限 shell 验收不能记为通过，也不能改为无约束执行。静态提示词或合成模型测试不证明自然语言判断完美；适配器检查不代表真实钉钉群投递。发布成功仍须同 SHA 的六组 Release、打包、npm 三包 integrity 和 GitHub Release 资产独立核验。

本轮本地证据包括核心通知/HTTP/Topic 相关 252 项、当前单元合同 125 项、正式 alpha.2 原生定时 12 项、final/observed 原生 9 项、通知与来源变更 27 项（其中 14 项真实原生 Host）、故障子进程最终清理 5 项，以及 `pnpm test:release-smoke` 14 项。部分文件先有失败，再仅补跑修正用例；这些数字分别表示对应最终路径有通过证据，不是一次整套全绿，也不能跨组相加。独立审查发现并恢复了 fairness 用例原有的必需环境断言，未允许缺环境跳过；未知产物操作场景加强为真实完成请求被拒绝，再等待。

独立协调原生尾项按正式 39 模块 alpha.2 profile 验证：`independent-coordination-native` 22 项及 `coordination-recurring-native` 1 项均有最终通过证据；前者是首轮 20 项通过后定向修正并补跑另外两项，不是一次 23 项全绿。诊断涉及合成模型未声明收件人、引用退役提示词/错误码，以及在公开回复放入内部 Task ID；均在夹具修正，原模型/工具校验不变。

最终组合再次完成发行 smoke 14/14、混合合同及映射守恒 18/18；恢复必需环境断言后的 fairness 3/3 通过、无跳过。最终目录仍为 332 文件（329 个 Release、3 个显式历史），没有删除文件或改变任何现有 release 标志。

## 合并后 Windows 复核

PR #315 合并后的 `a88a82ea17ab99fced30ce925e90a776fffcada3` 由完整 Windows CI run `41138535125` 验证。已完成的 unit 942/942、compat-0 1076/1076、compat-1 954/954、native-1 227/227 均通过。compat-2 为 933 通过、2 失败、5 跳过；history 为 191 通过、3 失败。此处先记录已知修复，整体结果须以全部分组终态为准。

- Node 24 Windows 的 `child.kill('SIGKILL')` 同样产生 signal `SIGKILL`，原测试误要求 signal 为 null、code 为 1。现在严格要求 kill 成功、code 为 null、signal 为 `SIGKILL`，等待 `close` 后才重开库，并在 finally 中等子进程关闭。真实冻结通知、原回执和一次发送断言不变。
- PowerShell AST 负例在 CRLF 检出时未实际替换 `exit` 行。仅将测试源规范为 LF，再明确生成 LF/CRLF 正例及六个负例；新增负例确实改变源文本的断言，产品 AST 校验和原始文件摘要校验不变。两项定向 2/2 通过，实际 CRLF 夹具另验 1/1，通过后恢复原字节。
- 三项历史 Runtime 失败均为合成回复漏声明受信接收人，触发当前通知路由校验。仅补 statusReply 与原 #124 的测试输入，不改生产、等待阈值或效果断言；三例 3/3、相关路径 5/5 通过。复审保留 fixture 原摘要及 fa14be0 basis，新增 #124 的单独审查证据；当前 Runtime 与守恒检查合计 52/52 通过。

## 保留 2.3.0 的标签恢复边界

本轮修复准备时，npm 三包仍未存在 2.3.0，GitHub Release 也不存在；失败 run 的构建/发布均跳过。恢复需先正常合并修复，再把原 annotated tag 对象 `8ff676edd1ef292cc21da6b332050191b00ab7d0` 保留到不触发发行的 `archive/failed-v2.3.0-fa14be0` 引用，并以该精确旧值为保护条件原子更新 `v2.3.0` 到最终 main 的新 annotated tag。远端值或制品状态变化时停止，不能盲目覆盖。

没有 npm 制品不代表没有 Git 消费者：已取得旧版本标签的克隆可能仍指向 `fa14be0`，需明确核对新提交；原失败 run 和归档引用保留取证。标签更新只启动强制发行验证，不能据此宣布发布成功。
