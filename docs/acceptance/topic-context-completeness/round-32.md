# Round 32：结束旧任务、部署与新流程全链验证

状态：进行中。

- 用户明确授权结束旧任务、重新执行并完成验证；同时明确允许本次两条UAT流水线通知。
- 本轮开始双端口无监听；恢复已安装旧包取得正式取消入口，原生启动PID24720。
- 两旧任务均已completed/cancelled，waitingReason=null；cancel-drained-snapshot.json的nodes/owners/effects/messages均0。原回执与历史保留。
- 新冻结bundle tasks-4fd1937b7fd631f1、checks-c34a5315b08839c2已通过零写组合检查，未激活；后端专项check v2包含两组实际测试。
- 首次维护切换方案：docs/spec/maintenance-bootstrap-switch.md。等待工具及隔离验证完成后按--check/apply执行。
- 重执行前发现v14强制非空修改，阻断后端现有正确实现的重新验收；实施v15显式无需修改路径，保持后续全部验证门禁，旧定义不热改。新部署包需包含此修复后重打。
- 独立复审首次切换需要完整Cordis disposer完成证据，单凭owner锁释放不足以覆盖后续runtime.close；追加本次nonce/PID/精确entry绑定的原生partial-dispose见证后才允许停旧Host。
- 新增前端固定伴随后端编译级隔离检查，实际ffe45... JAR拒绝于ApprovalNotificationOutboxTask，当前不启动该伴随服务，核对其开关与证明后才能重发前端。该发现不覆盖为PASS。

## 11:15 部署与正式重执行回读

- 用户明确允许本次两条流水线自动钉钉通知，任务自身报告仍仅Web。
- Bootstrap原生完整dispose见证通过，旧PID24720结束；备份D:/dsh_home/backups/owner-repair-20260927-110241-880及恢复校验完成。
- 新包SHA256 67f8fdcbd079f6d4cd918c668529dcbb85c3126236b8a7fa4cf1bcdef79b2012，84文件一致；新PID324，认证Web200/令牌交换303/恢复问题0，历史11任务76节点11运行及68旧任务回读一致。控制面degraded、inbound=false，不声称钉钉监听健康。维护revision3已正式resume。
- 后端正式新任务task-web-fb4df4eaeb0434892bc8accf5bd82548f1e1f4561866e3b1e38c0c0aefcc62b6，run-2c557ece5948861ceda4779784e492a9db1aa62feed99c34ca8212e17d0d5138；前三节点成功，prepare-workspace等待WORKSPACE_CONFLICT_UNSUPPORTED，Owner已block。保留失败证据，不重复外部写。
- 前端companion在既有隔离分支完成后台总开关补齐，本地55a366e3（未push）；新JAR a910900644dad0db7ad18546db1fda9027f12c8f46b8a214722de5f3beac52bc，真实Spring探针8后台Bean关闭且正常模式通过，旧包反例拒绝。新bundle tasks-66e31d6eaead4d29、tools a880a256已冻结并零写check，后端配置/checks v2不变；尚未激活和派发前端。
- C33/C34仍未通过，远程合入与精确版本UAT部署尚未执行。

## 后端首次重跑：同路径 add/add 工作区冲突

正式 prepare-workspace 的 `WORKSPACE_CONFLICT_UNSUPPORTED` 已定位为同路径 UTF8 add/add，未改变可信 taskBase。取证与SHA见 `round-32/workspace-add-add-diagnosis.json`；派生 Git 对象只写入独立 D 临时目录，业务源、远端和控制账无写入。

修复只允许祖先无该路径、双方 rename-aware diff 均为 A、普通文件模式一致且所有blob有效UTF8的stage2/3；保留原生marker，未解决禁止交付。源index/HEAD/文件字节不变已由真实Git fixture断言。删除、binary、binary-add、rename/rename和rename/add继续拒绝。

实跑：`node --test test/execution-workspace.test.js` 10/10 PASS；追加rename/add负例后重跑新增正例及扩展负例2/2 PASS，日志见 `round-32/workspace-add-add-tests.log`。净新增1个测试，既有负例矩阵新增binary-add、rename-add两类。本结果仅证明Host工作区构造，不声称新任务已完成业务验收或部署。

## 11:20 第二次维护部署与双任务启动

- 新包fd8d33b7a5b00bd61af240c73cb57728470db1343e3ec155fcaeb2b839921df3已安装，84文件一致；前端安全bundle已启用，profile39738ce3fae5facb46590a044ba1d86e90816cad609aaa31d0878ed9eb24352b。
- 新PID10604，Web200/恢复0；维护revision6已解除，12任务76历史节点12终态运行68旧任务完整回读，控制面仍degraded/inbound=false。
- 后端新task-web-cf7bb80115b1b2c42e796efa50e02f89005e9f0d325037f27c7ae8468f186aea，run-f5b9e9cd22eb75320629e365110873ebde41680fc75b6d3e4d965b9c4b27dbdd。
- 前端新task-web-61ed882b50b9d2dafb7c7906fc6b5977072e95e4c8ea41f1bc345593a1101586，run-bef3cd3f52b4b1e6a108c91d78af5eb7141499e6e528de5529da7f525af5693d。
- 两任务实际running，进入独立工作目录准备。尚未声称本轮业务验收/远程提测成功。

## 11:27 真实运行进展与前端读路径错误

- 后端workspace通过；方案明确仅解决MergePreviewCalculator文本冲突，保留现有归一化及8处后台开关实现。apply-changes成功，进入verify-candidate；本轮测试/业务结果尚待回读。
- 前端workspace通过，但方案模型误读src/components/ReviewDimensionPanel.vue；实际路径src/views/review/components/ReviewDimensionPanel.vue。ENGINEERING_READ_PATH_INVALID被execution-session一律终止为execution_tool_failed，Owner阻断。不存在业务写入，也不能算业务验收失败。
- 前端该尝试已正式cancel并独立回读completed/cancelled。修复授权范围内不存在文件的可纠正返回，保留越界等安全拒绝；修复后安全维护部署再正式重发。后端仍继续运行，不重启。

## 前端路径猜测导致会话停止

正式前端模型读取允许前缀内不存在的 `src/components/ReviewDimensionPanel.vue`，旧Inspector抛错触发原生会话 `execution_tool_failed`，阻断其余queued读取。现仅此受信快照内不存在路径返回正常 `not_found` 与 list建议；不修改通用isError→halt逻辑，安全/权限/身份异常仍停止。

实跑：原生Session全文件16/16 PASS（新增两个测试分别覆盖同session缺失→queued合法read→list→正确read→submit，以及scope/path/link/EACCES/stale五类错误仍halt）；真实Registry定向1/1 PASS（缺失结构化结果、后续read、越界及身份反例）。日志：`round-32/read-path-native-tests.log`、`round-32/read-path-registry-tests.log`。测试夹具同步携带当前v15正式注册targetCommit/taskBase，避免旧fixture工作区身份失配；未改业务目录/运行库/远端。此结果仅为Host定向验证，实际部署与前端业务验收另行回读。

## 11:50 后端本地验收通过、PR更新效果未知

- 本轮22专项测试通过（0失败/错误/跳过），构建通过；candidate e50dc36514404f6e37a188cc3f7d5d4af6f1ab3d75aecd0cd24bab7677d41489。
- 本地真实场景preview/confirm及独立数据库读取均为1 t，persisted=true；cleanup/dataCleaned/processStopped及verify-cleanup全部通过。完整回执backend-local-acceptance.json，identity dbb216462ccee2ef6e4d159a05dc0a7ab1147710ec8f2c09256b1217480f6c82。
- 本轮提交3ea89c0d4daf970a5be9b8a7d40e7ec81f2da842已推现有开发分支；create-pr节点等待DELIVERY_RECONCILIATION_REQUIRED，effect git-53f2dfc6458bb6f3e171908285fd98233bfc09e5c4fe1c320ecbd50cbe6a8b57原因为PR_READBACK_FAILED。
- 实际PR371 OPEN/UAT3/head本轮提交；正文仍旧marker，本轮7ea9c8f8未观察到；lastEditedAt早于本次操作。旧adapter缺调用阶段日志，不能据此证明未发送，保持unknown、禁止盲重试/手改账。
- 前端read-notfound修复新包401c4531052988aca7166aa2c5716977bf685d449b60c2afc0d977d5f5feb413，84文件一致，尚未部署。当前unknown需先受信恢复收口，不能绕过维护排空门禁。

## PR 发送阶段证据

旧 PR unknown 已只读定位到 PR_READBACK_FAILED，无法区分历史 preflight/post-send。新实现持久阶段日志与只读最多三次重试，旧效果不补造证据。定向 execution-pr 测试覆盖 preflight 零发送、认证不重试、ACK 丢失、发送意图重启、并发单发、损坏/错身份日志、旧 reconcile 零日志写。日志：round-32/pr-phase-tests.log。未操作远端或运行库。

独立复审补充：覆盖 preflight-failed fsync 后 observe 前重启，仅 reconcile 恢复 failed；send-intent 优先、损坏记录拒绝、旧无目录 reconcile 不创建目录。已重新实跑同定向文件。

## 恢复准备检查点

后端本轮 22 项测试、真实 1 t 业务验收与数据/进程清理已通过。PR #371 更新仍为 unknown，等待用户对这一次标题/正文恢复的明确确认；两条 UAT 流水线自动通知已获授权，无需重复询问。恢复工具隔离测试 11/11、PowerShell 检查 5/5 通过，现场零写检查因尚未恢复而按预期阻断；未创建发送预约或执行真实恢复。最终待安装包 SHA256 为 90de489e614bcf3cb82b1c4ee0bae4cb5dc92e60ea28e8124a9ae92754efc5c3，84 文件核对一致，替代前一待安装包。当前实例仍为 fd8d33b7 包；前端修复尚未部署和重跑，两条 UAT 全链尚未完成。SG15 维持进行中，round-32 的 C33/C34 FAIL 保留；后续修复重跑另记 round-33。
