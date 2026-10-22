# 第9轮合并与部署前独立验收

- 负责：progress_audit；统筹：root。
- 用户追加目标：合并 PR #248 并部署本地。本成员仅承担独立合并审阅与定向验证，不合并、不改生产源文件/映射、不切换分支、不触发 CI 或部署。
- 当前阶段：等待统筹 fetch 后的实际冲突清单和解决 diff。
- 工作目录：`D:/codex/worktrees/task-collaboration-quality/dingtalk-dsh-assistant`。

## 已观察基线

只读快照：HEAD `88e28f48f32e8f2f354b5b947d092025bfc3ed86`，本地 origin/main `3fd56f92212155f303cf3935748c9381c75ff632`，共同基线 `192e808f94744e1fa13b32c9d3b11473218e89a1`。这是统筹 fetch 前本地引用，不代表远端最新状态。工作区仅有既有 docs/tmp 未跟踪产物；保留不清理。

已知上游 #247 消息延迟修复改变协调目录读取、时间锚点、失败重试与告警收口；在 task-session-service 中增加 `onRecovered: id => failures.delete(id)`。本支 SG1–7 改同服务的执行路由、当前文档投影、反馈/效果账、恢复及 UI DTO；合并应同时保留两边合同，不以整文件 ours/theirs 覆盖。

## 必须审查的交互边界

| 边界 | 需要保留的事实 | 最小定向证据 |
| --- | --- | --- |
| 协调恢复与服务告警 | 失败退避时告警仍在，持久语义接纳后清除对应告警；不重置原重试次数、不误清执行错误 | 上游 independent-coordination-native 的 recovered alert 用例；recovery/changes 单元 |
| 执行后端身份 | 默认及历史缺字段为 DSH；配置变化只影响新成员；原 CLI/DSH 续办与重启保持原 session/backend | task-execution-backends 的真实服务+SQLite混合团队用例 |
| 反馈与效果账 | peer 同任务/当前目标轮次、ACK不等于处理、旧结果不能越过新反馈；未知效果及未排空仍阻塞重放 | 根据实际合并触及位置选择 Store/CLI/native 小组；未触及 adapter 不盲目重跑26例 |
| 逐轮文档与阶段事实 | 先冻结旧轮再切 inputVersion；同轮最终刷新；旧stage/result不冒充本轮；写文件失败不遗留running孤儿 | progress-native 的真实两轮文档用例；若改投影再补 model-context/session-workspaces |
| 协调只读目录与团队约束 | 查询全部原任务只读取目录，不扩大修改授权；3–10成员合同不被旧测试夹具/合并覆盖 | 上游17/41任务目录查询；现有team完成/上限测试按实际触及范围选择 |
| 时间锚点/延迟扫描 | 保留原消息发生时间与原计划时间，不以模型处理结束时间顺延；过期边界不重放 | coordination-schedule-revisions 与 independent-coordination-recovery 相应新增用例 |
| 看板和发行入口 | CLI使用真实日志/文档入口，不跳转伪DSH会话；新模块仍在包清单；测试映射/历史合同不放宽 | 实际冲突涉及UI/manifest时补对应测试；正式mapping及release smoke由统筹统一 |

## 运行原则与分工建议

先审实际三方差异与冲突解决，再按交互边界选择测试，不跑全量。原生/真实进程 lane 与其他成员串行协调；本成员可承担非原生的协调 recovery/changes/schedule 小组或 backend/doc 小组，运行前由统筹分配避免重复。新增日志放本 round-9，不覆盖 R7/R8 首错与冻结结果。

合并diff/测试、GitHub merge回读、包/安装摘要、进程健康、浏览器/业务功能是独立证据层；本成员的源代码审阅和定向测试不能替代统筹的实际部署确认。真实 Claude 账号仍待用户后续登录，本次合并不把之前离线协议验证改写为真实账号成功。

## 当前结论

尚未审定合并结果，尚未执行本轮测试。等待统筹提供最新远端引用、冲突路径、解决结果及冻结检查点。

## 实际融合审阅

统筹 fetch 后 origin/main 仍为 `3fd56f92212155f303cf3935748c9381c75ff632`。实际只有 README 冲突，已同时保留上游两段“只读目录目标/来源消息时间”说明和本支“DSH 推理深度”限定。`git ls-files -u` 独立回读为空；暂存 task-session-service 相对本支 HEAD 的唯一新增行为是 `onRecovered: id => failures.delete(id)`。逐项核对后端固定、文档发布/读取、反馈当前版本过滤、CLI readback 拒绝及原生恢复分派仍在，未采用整文件覆盖。

本成员已按统筹分配独占 native lane 启动最小组，实际文件名为 `test/task-session-progress-native.test.js`（不存在 task-execution-progress-native）。锁定 `test/fixtures/native-profile/package.json`，串行选择：上游 recovered clarification 告警 1 例、backend 混合团队 1 例、progress 生命周期/两轮文档/人类等待及纠偏 6 例。日志为 `merge-native-boundaries-1.log`，运行前后服务源码与 profile 摘要另记 `merge-native-boundaries-1-source.json`。尚在运行，不能提前计 PASS。

## 定向验证完成

`merge-native-boundaries-1.log` 独立回读：**8/8 PASS、0 FAIL、0 SKIP、exit 0，78.36 秒**。上游成功澄清后清旧告警且保留原重试次数；默认 DSH/混合团队/配置切换/重启保持原执行后端和旧轮文件；十分钟进度时机、真实两轮文档与计划、人工等待不被结果越过、等待证据与一次纠偏保留原执行身份，均通过。

运行前后 task-session-service SHA256 均为 `55bd8a8fe2ae134d8aae6fe1ac59485e56007790b351c7cbe2a630c9b22335e1`；锁定 native profile SHA256 为 `be97a40c0a0ea24278557230b9011f0d70036939841b1cfd7602a9027a175b58`。完整参数与退出码在 `merge-native-boundaries-1-source.json`。测试期间服务源码未漂移；没有运行全量、追加 CI 或现场业务调用。

本成员审结：实际 README 冲突解决及服务自动融合未发现需要阻止合并的回归，所分配交互边界已有本轮定向验证。未改任何源码、测试或 suite-map；仅新增本 R9 执行文档及日志。native lane 已交还统筹。PR真实合并状态、部署包/安装摘要、现场新进程/健康与功能回读仍由统筹独立核验，本结论不替代这些证据。

## 部署 checker 后端兼容缺口追加审阅

合并前发现既有 `docs/acceptance/task-session-runtime-repair/scripts/inspect-quiescent-ledger.mjs` 将所有已绑定执行都按 DSH `.dsh/sessions` 检查，无法接纳合法 CLI journal。统筹暂停合并并将同因修复纳入 PR；collaboration_eval 修改既有 checker 与同目录测试，本成员只读审实现、核对反例并维护本记录，不改生产源码或公共测试。

现有 launcher 会将 checker 原文件复制到实例的 launchers 目录独立运行，因此实现必须仅用 Node 标准库。默认或历史缺失 executionBackend 仍为 DSH；Claude 分支必须核对原 task/execution/session、provider UUID、完整输入历史、递增租约、连续序号及持久末尾 drained，不能跳过 CLI、用 exit 0 代替排空、清除 unknown 效果或修改旧 owner 元数据。冷启动的正式 Host 恢复合同与部署停稳检查不同，保留既有 startup 分支。

已从真实 Store 查明的相邻状态：`execution.continue` 仅要求已 drained 且曾领取，既可从终态续办，也可对尚未开始的 queued 再次续办；每次 inputVersion 增加且旧输入进入 inputHistory，leaseEpoch 不变。`execution.claim` 才增加 leaseEpoch 并置 drained=false。`execution.cancel` 可把已 drained 的未开始续办改为 cancelled。因此未开始续办应按“末 drained 同当前租约、其输入在 inputHistory 精确匹配、当前无已开始新轮”证明，而非硬限相邻 v-1；允许 queued，或有 cancelRequested 依据的 cancelled，且报告为未开始，不能伪称本轮执行完成。已将连续两次 continue/cancel 的真实 Store 正例要求发送实现者。

另已指出初版 taskId 路径规则比生产 `taskSegment` 窄：生产允许中间点号，并拒绝尾点与 Windows 设备保留名。checker 应保持一致，executionId 则遵守 CLI 自身的原路径合同。路径需逐祖先拒绝链接，journal 拒绝符号/硬链接，打开后核对文件身份；错误路径或身份不得读取外部内容后放行。

当前新增分支仍在实现与定向验证中，尚未审结。前述 8/8 合并测试仅证明其原有边界，不覆盖此后新增 checker；不重复全量或未变更的原生测试。

## Checker 独立审结

最新冻结 checker SHA256 为 `2c2c0438a572319669a884fc880bcf810856103f831c4cf0f314c29d38e7715b`，同目录测试 SHA256 为 `39e903a5125d458dee93c320809b94ba844fb13743aa6685de88ed05e0785693`。独立回读实现者日志 `deploy-cli-checker-verified.log`：**53/53 PASS、0 FAIL、0 SKIP，11.65 秒**。旧 48 例结果及首次夹具错误仍保留，不将旧结果套给最终源码；真实 Store 更新命令为 `task.revise`，新增 queued/cancelled/stale 三态用例用其实际命令链生成。混合 DSH/CLI、复制后独立运行、历史缺 backend、未知/null backend 拒绝、版本/租约/序号/归属错配、缺失/截断日志、未排空、连续未启动续办、目录链接与硬链接、unknown 原样保留均已有对应断言。

源码审阅确认仅为已绑定 CLI 执行增设按原 journal 的只读验证，原 DSH、Task 未启动领取特例、离线 owner 校验及 startup 恢复分支保留。路径规则已与生产对齐；每个 start 的输入必须匹配账本完整历史，租约严格增加且不超过当前；非 start 事件绑定同轮，前轮和末轮须有 drained；当前行或未开始续办必须满足精确租约条件，不能拿旧租约排空放行。session.bound、provider UUID 及每条 CLI 顶层 session_id 受核对，exit/result 无法代替 drained。unknown 效果只读计数，未清账、重放或更改恢复事实。此轮独立审阅未发现尚需阻止合并的新问题。

为避免仅凭手写 journal 夹具形成假收敛，本成员另外实跑了原字节重放，证据为 `checker-native-journal-replay-1.json`：取 R7-final 真实 Claude CLI + Host adapter + 生产 Store 的执行记录与 operations 原始 body、59 条 journal 原始字节，写入新建临时执行级夹具；最终 checker 同 SHA 下返回 verifiedSessions=1、drained=true。原 UUID 保持，inputVersion=2、leaseEpoch=2，journal 61,947 字节，SHA256 为 `8b5772c0f2ac06de9369f77217b3828de2a024f97400e9bd1552e22de765fd85`，末序号 59/type drained。执行后独立比较原库 body、原 journal 与副本字节均未改变。

该重放明确只验证执行日志合同：R7 原探针的 Task owner 未排空，原整库仍如实被拒绝 `DEPLOY_NOT_DRAINED`，没有修改它来制造部署成功；新夹具不包含该未测 owner，不是完整实例停机证明，也没有再调用模型或登录账号。正式 launcher 脚本复制/hash、真实实例停稳/安装包/进程/健康仍由统筹执行并另留证据。本成员只改本 R9 文档并新增重放结果 JSON；未改实现、测试或共享映射，也未重复运行原有 native 全组。
