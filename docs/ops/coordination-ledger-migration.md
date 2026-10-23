# 协调账本 v1→v2 离线迁移与兼容回退

本文是后续维护操作手册，不是部署记录。本次实现验证仅使用云端临时目录、
隔离 SQLite 和假投递/模型适配器；没有访问百部、生产库、真实群或生产配置。
迁移、启动实例及变更实际配置仍须处于该次维护的授权范围内。

## 基线与不变量

方案 v1.3 的原审查基线为 `99a429fc`，发布说明基线为 v2.1.0 `7ca36c26`。
本次重新对照 main `94f99720836e134f0615dc7e02f0f4d4bd72b7e9`；其已包含
测试分类调整和 PR #236 的空 Owner 返回恢复。该版本实际动态账本仍是 schema v1，
只有新库初始化分支，没有 v1→v2 增量迁移。不能拿历史文档行号或发行版本推断数据版本。
Owner 默认 astra 和执行模型设置不因迁移改变。

新账本使用真实 `PRAGMA user_version=2`，保留 application_id、instanceId、
initToken、初始化 marker 和 ingressEpoch 绑定。旧 v1 包读取 v2 必须在恢复、
Topic replay、到期扫描和业务调度前拒绝，不能降版本号或只加表伪装兼容。
Task、Execution、原命令收据、来源、唤醒和锁仍属于原 TaskStore，不复制到另一账本。
历史执行只追加 `existing` 指令范围标记，不倒推它已覆盖新协调指令或满足新顺序。
历史完成回执保留原身份；迁移不伪造新的全局业务完成事件。

## 停写与只读检查

1. 确认实际包/提交、profile、Agent 工作区、动态库绝对路径、instanceId、绑定 epoch、
   初始化 marker 及原生会话目录。不要从本文示例推断现场值，不输出凭据或 initToken。
2. 沿现有 Host 生命周期停止新消息接纳和后台调度，排空 Task Owner、执行会话、
   群协调会话及真实子进程，再正常关闭旧 Host。SQLite 中 `drained=true` 只是账本证据，
   不能替代真实会话/后台效果排空；不以强杀业务进程完成这一前置条件。
3. 未排空 Task/Execution/Group、未终结操作、starting/unknown 通知或活 owner 都会阻止迁移。
   先沿原身份对账，不能删除 unknown、清库、改 marker、改 epoch 或改 instanceId 绕过。
   保留主库及有效 WAL、marker 和原会话；脚本不自动创建空账或历史副本。
4. 在目标兼容代码目录执行只读检查。默认无 `--execute` 就是只读，`--check` 只是显式写法：

```powershell
$coordinationDb = '<实际动态库绝对路径>'
$coordinationInstance = '<实际 instanceId>'
$coordinationEpoch = '<原来已绑定的 ingressEpoch>'
$migrationArgs = @('--db', $coordinationDb, '--instance-id', $coordinationInstance)
if ($null -ne $coordinationEpoch) { $migrationArgs += @('--ingress-epoch', $coordinationEpoch) }
$review = & node scripts/migrate-coordination-ledger.mjs @migrationArgs --check | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or !$review.ready) { throw '迁移检查未通过；读取 blockReasons 并沿原流程排空/对账' }
$review | Select-Object schemaVersion, expectedDigest, markerDigest, rowCounts, blockReasons
```

只有原账本确实未绑定 epoch 时，才把 `$coordinationEpoch` 设为 `$null` 并省略参数。
不能以空字符串、当前时间或另一个日期代替旧绑定。
检查报告只含身份、摘要、计数和阻断原因，不打印业务原文、marker token 或凭据。

## 原子执行与确认

读取并核对检查结果后，沿用同一实际参数和该次摘要：

```powershell
$migration = & node scripts/migrate-coordination-ledger.mjs @migrationArgs --execute --expected-digest $review.expectedDigest | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or !$migration.historyPreserved) {
  throw '迁移未获得完整成功证明；保留数据库、WAL、marker与输出，先核查是否 committed，不启动调度'
}
$migration | Select-Object schemaVersion, migrated, unchanged, committed, historyPreserved, markerDigest, rowCounts
```

`expectedDigest` 覆盖 application_id、user_version、全部 v1 业务表及身份元数据，
仅排除进程临时 owner 值。TaskStore 在同一连接 `BEGIN IMMEDIATE` 后、任何 DDL 前
再次比较摘要；两次检查间旧 writer 有任何业务写入就拒绝，不自动接受新状态。
需要重新只读核查原因，再决定是否采用新的检查结果。

事务内先验证身份、旧 owner、排空条件和摘要，再创建协调表/索引、更新 user_version，
最后提交。事务里不创建会话、不调用模型、不发送 HTTP/钉钉；不会另开同文件 writer。
迁移后比对历史行及 marker 字节，验证新 schema 和协调索引。唯一允许的历史执行行
增量是既存输入范围标记。再次对已确认 v2 执行相同脚本是只读 no-op，不重新恢复任务。

失败分三类处理：

- 前置/摘要失败：无迁移 DDL 提交，保留旧账及未知效果，解决原原因后重新检查。
- DDL 期间进程退出：SQLite 保证整个事务回滚；再次检查应仍为 v1 且历史摘要/marker 不变，
  然后可用重新核验的身份重试。不能仅凭退出码认定一定没有提交。
- 已提交但回读/历史核验失败：报告可能包含 `committed:true`；不要降版本号、恢复旧快照或
  启动旧包。保留现状，用兼容代码只读核查并明确处理结论。

## 兼容关闭与冻结

回退使用仍支持 v2、来源归属、依赖门禁和通知许可的兼容包，不切回旧 v1 包。
不能恢复旧数据库快照覆盖已经发生的任务进展或外部效果。

关闭新协调接纳但续办原安排：

```yaml
taskSessions:
  coordination:
    enabled: false
    mode: active
```

该模式不让新来源调用协调模型；已保留的 coordination unit 仍独占，已有接纳安排、
固定命令和时间计划继续沿原身份恢复。`reserved` / `needs_clarification` 不会因为关闭
开关就退给 Topic，也不会提前 settled。不能用开关冒充持久所有权交回。

需要暂缓已接纳协调工作的新增效果时，使用兼容冻结模式：

```yaml
taskSessions:
  coordination:
    enabled: false
    mode: frozen
```

兼容 Host 必须在任何 replay/扫描/claim 之前把该模式提交到同一 TaskStore 的
`coordination.runtime.set` 受控入口。持久 `frozen` 阻止协调接纳/派发、到期扫描与作业认领，
并在 execution.claim 和 notification.start 最终门禁阻止相关新执行及新发送许可。
来源、成员、指令、slot、完成事件、回执和通知 payload 全部保留；无关原 Task 的既存范围
不因协调冻结而全局停止。重新设置 `active` 也是明确的受控操作，不能靠删元数据解除。

冻结不撤销已运行执行、已获发送许可或未知外部效果。已经越过效果边界的工作仍须沿
原身份排空或回读；不能保证撤回群消息。需要停止原 Task 时仍走其原控制合同。
更换代码后确认两域 dispatchOwner/generation 一致、同一 occurrence/command/notification
没有被新造身份，才可恢复接纳。此操作不使用“清空后重新导入”或全量 legacy 交回。

## 隔离演练证据

### 已为 v2 的实例安装协调修复

本次协调审查修复没有增加 schema 版本或新配置；已是 v2 的实例无需重跑迁移。仍沿现有受控安装流程核验实际包、进程与健康状态，不清空协调账本或重建安排。恢复时历史计划保持 schedule 身份，取消的局部指令不再阻断原任务；新改口会替换待澄清的顺序评估，不能提交旧 assessment 回执代替新评估。

核验应包含：周期实例已接纳后修改未来收件人；时间和原任务完成两种先后顺序；局部撤销后原 Task 新输入；前置等待/暂停队列之后其他群的可运行项；离线错过单次查询后明确过期通知和聊天原因查询。已存在的过期查询可能在首次恢复时产生之前遗漏的异常摘要，这不是重新执行过期查询。已送达/未知摘要沿原通知身份处理，不能为核验而重发或删除通知。

Windows 强制退出演练检查子进程确已到达注入位置，并按平台核验真实终止结果，再读取 SQLite 的原子性和恢复事实；不能只因 Windows 不返回 POSIX signal 就跳过后续恢复断言。

消息延迟优化同样无需 schema 迁移或新配置。核验短延时查询应检查原消息时刻、原计划时刻、规划次数和实际送达；不要把受控模型调用数减少当作真实线上耗时下降。已接纳或已发出的旧澄清不会自动重判或重发；不要手动改库补跑。规划重试成功后旧故障告警会退出活动列表，但持久 attemptCount 不重置。性能接口若标为 incomplete，应补查原生会话元数据并区分消息发生时间、路由、决策、工具和投递，不把业务完成回执当作首受理响应。

纯消息提醒新增 `message-reminder` 动作，复用 v2 计划、实例及通知账，不新增表或配置。升级后用获授权的新测试消息验证：先请求提醒，再对同一事项订正时间；只有一个有效计划、没有虚假 Task，到时正文正确且回读送达。不要重放旧消息创建已经过期的提醒。规划输入的 `timeContext` 来自 Host 实际工作时区与消息时间，部署前核对系统时区；用户明确的日期/时区仍优先。缺失来源时间不补造，确实过时或冲突的请求仍须澄清。

提醒验收另核对原生 `@` 对应人员：来源身份须为真实 `openDingTalkId`，普通群发送与引用回复均传递原生提及参数。DWS 成功任务与精确消息回读仅能证明送达；若查询未返回提及元数据，需由客户端观察确认，不能用 `userId` 或命令中存在参数冒充实际提及证据。协调安排、变更、查询、异常及人工申请正文不得展示运行 ID、收件人 ID、版本号或零项技术统计；业务时间使用工作时区，内部审计字段不删改。新自由文本在接纳前校验；历史冻结正文保持不变，若触及外发守卫则保留失败证据，不直接修改数据或补发。

到期提醒在通知冻结时绑定同群已接纳来源的消息和作者，复用现有引用回复；最新订正后的来源仍须从 Host 账本取得，不让模型填写。发送编译需用实际 CLI `--dry-run` 验证：普通群发要求原生提及占位符，引用 leaf 自动补齐；预检必须返回 executed=false。真实到期后另核对引用和“@我”只读查询，后者明确命中原消息可作为独立提及证据。已有冻结通知不改写。历史单成员缺占位符的精确 CLI validation 负回执，在完整许可和唯一尝试身份一致且无 ACK/receipt 时只结清 failed，其他错误保留 unknown，不重发旧提醒。

延迟排查分别读取来源时间、通知 `createdAt`、真实 `sendStartedAt`、ACK 和送达回执。历史投影会去除以创建时间冒充的发送开始时间，缺值应查原命令回执。无更新的待处理来源时，prepared 通知及时发送、槽释放后自动续队、相同投影无重复写盘；保留全局限流。对协调来源回复，同群同人的更新来源已准入但尚未完成本轮判断时，发送许可事务暂缓旧回复；确认是订正后退役旧回复，不同事项判断完成后恢复原回复。新的 needs_clarification 属于已做出判断，不等待用户答复才释放。starting/unknown/delivered 不撤回或重发。新增提醒落账后不可直接回滚到不认识该动作的旧包，应先暂停新接纳、排空或按原身份取消未开始提醒并核对未知效果，保留完整账本。

DWS 外部幂等键最长 128 字符；四类发送编译入口对超长键使用固定前缀与完整 SHA256，短键和内部通知 ID 保持不变，回读识别同一映射。历史 unknown 仍按原身份核验；仅原发送尝试保存了完整 uuid 参数校验拒绝、发送许可和对应长度、无 ACK/receipt 时，沿官方 notification.reconcile 标记 failed，并同步 occurrence 的失败状态，不重新发送。不满足严格负证据的 unknown 继续保留，不能凭泛 PARAM_ERROR 或缺失回执宣称未发送。升级后独立确认原通知发送次数未增加、失败证据未丢失；使用新测试消息验证真正送达。

`test/coordination-migration.test.js` 通过 `git show` 从固定 `94f9972` 导出未经改写的旧
TaskStore 及其本地依赖闭包，在临时目录实际运行旧 v1 程序生成历史 Task、Execution、
来源、群会话、唤醒和完成回执。没有将当前 v2 库篡改 user_version 当作旧库。

实跑覆盖：只读 CLI 零数据/marker 写入；历史及身份保留；真实旧 v1 程序拒 v2；
迁移 DDL 后/user_version 前真实子进程 SIGKILL 的原子恢复；独占事务内摘要竞争拒绝；
活旧 owner/未排空群拒绝；错误身份/epoch/摘要拒绝；兼容关闭接纳而恢复已接纳指令；
持久冻结重启后阻断相关 claim/发送许可且无关 Task 可继续。
这些是隔离程序演练，不代表生产迁移、真实模型或钉钉外发验收。

精确引用提醒的直接处理和上下文优化无 schema/config 迁移，沿同一双包受控部署。验证原生引用已送达确认后，单条未分派纯文本改期直接进入协调模型，首轮包含原规则和版本，不调用话题归类或重复读取目录。另验混合普通业务先无效果整条交回，再由原路由拆分；该来源不会再次直接进入协调，未命中条件的消息仍沿原路径。A 设置提醒 B 时分开核对来源作者与日程接收人，改期不得改成提醒 A。实际耗时须从原消息时间到群内回复独立测量，隔离模型 1 次提交通过不等于线上响应已达标。部署期间冻结用于检查的源码检出，后续开发不得并行修改包源码。

监听显示 ready 只证明订阅就绪。排查入站等待时同时核对 `/state/dws-bridge` 的 `lastEventAt`、原生事件 consumer 的 received/dropped 和历史补拉时间；当前 DWS 过滤登录用户自己发送的实时事件，本人客户端指令可由历史补拉接纳。若只有消息平台创建时间、没有 Host 首次接收时间，不能把首模型请求前全部耗时称为模型排队，也不能将轮询周期缩短冒充实时事件修复。
