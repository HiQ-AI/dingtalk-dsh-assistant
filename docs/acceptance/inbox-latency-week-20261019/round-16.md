# Round 16：收发恢复、风险回归与发布烟测

2026-10-26；`worktree-inbox-failure-fix`，基线 `dc41f69f`。本轮只提交新修复 PR；不合并、不部署、不触发 CI、不重放真实消息、不外发、不改业务账、不停业务服务。PR260 的安装验收是历史，不代替本轮验证。

## 最终结果与失败保留

| 项目 | 结果 | 独立证据 |
| --- | --- | --- |
| 相关风险组 | 412/412 PASS；fail/cancelled/skipped=0 | `round-16/risk-regression.log` |
| 后加队列锁、Host/协调原生恢复、accepted/applied/frozen、新鲜度 | 35/35 PASS；0 fail/cancel/skip | `round-16/final-targeted-rerun.log` |
| 最终全部变更测试文件（不含另外实跑的解包文件） | 312/312 PASS；0 fail/cancel/skip | `round-16/final-changed-tests.log` |
| 真 Edge + fixture HTTP | 9 checks PASS，errors=[]、writes=[] | `round-16/ui/browser-result.json` |
| 首次 release-smoke | FAIL：11 pass、1 fail、2 cancelled | `round-16/release-smoke.log` |
| 单独真实解包原预算诊断 | 2/2 PASS，0 fail/cancel/skip | `round-16/package-stage-diagnostic.log` |
| 映射修正后的原命令 smoke | 14/14 PASS，0 fail/cancel/skip | `round-16/release-smoke-rerun.log` |
| 进一步细分原生与清理阶段后原命令 smoke | 14/14 PASS，0 fail/cancel/skip | `round-16/release-smoke-stage-final.log` |
| 映射审查 | 308 文件、历史3；30闭包仅追加、0删除/重分类 | `round-16/suite-map-review.json`、`round-16/suite-map-check-final.log` |

以上组合有重叠，不相加为总覆盖数。412 项之后增加的测试使用最终35/312项证据，不能用旧绿测遮蔽新版失败。旧 `round-13` 红测、`round-14` 浏览器断言失败以及本轮首次 smoke 失败均保留；冻结历史 report 不改写为本轮全绿报告。

## release-smoke 失败定位与修正

首轮 `test_suite_map_stale` 是确定失败，另两项为真实解包 native 用例 30000ms 超时取消。原日志未包含细阶段时钟，不能事后断言当时卡在 npm、原生 Host 或清理。按既有 `node scripts/test-suites.mjs update` 重新生成映射，逐项核分类守恒；没有改脚本分类、lane、release、历史出口或发布根，没有删除断言/跳过测试/放宽预算。

独立审查：308 文件不变，历史3不变；30个条目只追加 group-message.js / notification-delivery.js 的静态导入闭包，共42行新增、0行删除；`publishedBoundary` 未变。`check` 实际输出 `verified 308 files; every file exactly once; historical 3; deleted 0`。

只在既有解包测试添加 `t.diagnostic`：pack、extract、字节/import检查、依赖准备、原生 Host、ingest、whenIdle、断言、关闭、临时目录清理。不更改业务测试、30000ms 单例预算、npm/tar命令或 smoke 并发策略。

最终同一 smoke 命令中首个用例总 26875.8ms，各阶段为自 pack 开始的累计 ms：

| 阶段 | 累计 ms |
| --- | ---: |
| staged / packed / extracted | 496 / 3658 / 3814 |
| bytes-and-imports-verified / dependency-links-ready | 7555 / 7775 |
| runtime-imports-ready / native-host-ready | 8446 / 13517 |
| message-ingested / native-task-idle | 13575 / 25112 |
| native-task-verified / native-host-closed / temporary-files-removed | 26476 / 26569 / 26872 |

本次主要后段为原生 Host 准备约5.071s及任务执行约11.537s，不是 npm 打包独占全部耗时；本次关闭约93ms、临时清理约303ms，没有清理卡住证据。第二个 resident 用例总10022.7ms：依赖准备6724、Host8471、listen9455、health9472、closed9501、清理10020，启动不调用模型的断言也通过。

最初 smoke 曾与风险组并行运行，同机资源竞争是候选；没有同条件资源监控/对照，不能认定为唯一根因。首个用例距30s预算仍较近，原超时具体原因未收敛；后续保留阶段诊断帮助定位，不称已解决环境抖动、不声称性能提升。修映射的确定性工作和超时的诊断边界分开交付。

## 安全恢复的实测边界

- 收件严格本机身份、path绑定、strict JSON body、messageVersion/activeUnitRefs/原request或reservation/token。入口与持久化队列内再验，旧token/并发仅一次；原生Host前置来源失败恢复后原消息/source/task/outbox均不复制。unknown effect不解锁。
- 跨Resident版本队列直到独立ledger CAS提交保持锁；同一消息新版本不能夹在核验和ledger写入之间。dispatch在锁外，accepted/needs_clarification/frozen ownership及accepted/applied协调账拒绝重置。
- 发件 prepared可首次送；failed须原生持久严格未发送proof且retryable、无ACK/receipt；unknown/starting只readback；delivered/superseded/retired/recall不发送。共享单飞、持久CAS、原幂等身份，不靠按钮禁用保护。
- 手动回读占通知串行槽时新prepared通知先等待；释放后沿既有drain续扫，当前attempted排除本次条目，避免失败/unknown立即自重试。sourcePending沿原processingRevision唤醒。
- 查询事实freshness在原生send permit事务判定；手动入口不能抢在自动refresh前发送旧结果。已有permit的unknown/starting保护不变。
- 子进程permit测试初次失败见 `round-16/permit-diagnostic.log`：子进程未继承parent mock Date，真实日期已超查询新鲜度，尚未取得permit。测试显式传递parent时钟后，网络调用前/后两种SIGKILL均通过；未放宽freshness或删除崩溃断言。
- UI接入真实HTTP投影；鉴权未修再次失败、修复后按新态恢复、同步单飞、旧态拒绝、unknown核验、delivered不展示重发均由fixture验收。浏览器脚本是合成runtime，不是真模型/渠道或已部署验收。宽屏、失败详情及390px截图已目视；窄屏沿既有宽表横向容器，不宣称所有列在手机同屏。

根因与成功慢样本的直接证据、反证及空窗见 `round-15.md`；不将 Task running/waiting 的具体缺陷泛化为真实五次失败唯一原因，也不把 turn 称独占模型时间。

## 再生成

在当前 worktree，以 PowerShell 7 执行（原生profile只作为测试依赖，不连接真实业务库/模型/渠道）：

```powershell
$env:DSH_NATIVE_TEST_PROFILE='<isolated-native-profile>/package.json'
node --test test/coordination-ledger.test.js test/source-dispatch-ownership.test.js test/task-background-retry-native.test.js test/coordination-notification-freshness.test.js
node --test test/coordination-ledger.test.js test/coordination-notification-freshness.test.js test/http.test.js test/observer-client.test.js test/source-dispatch-ownership.test.js test/task-background-retry-native.test.js test/task-message-projections.test.js test/task-notification-delivery.test.js test/task-session-http-integration.test.js test/topic-runtime.test.js
node scripts/test-suites.mjs check
pnpm test:release-smoke
```

浏览器复用 `scripts/verify-inbox-browser.mjs --root <本worktree> --output <新round证据目录> --playwright <已安装playwright入口> --react-dom <与workspace React精确匹配的react-dom目录>`；不能加 installed-profile 变成部署动作，也不能移除请求拦截。依赖路径由本机安装决定，不把临时job包或大PNG入库。

## 交付状态

源码/测试/文档验证完成；PR与权威同步分别以独立回读为准。`goal.md/shared-tasks.md/matrix.csv` 唯一权威仍在主检出任务根；工程树仅产出 `docs/tmp/inbox-round16-progress.patch` 交Codex合法应用，不直接写主仓。旧COMPLETE属于PR260历史，补丁将其改为本轮进行中并追加SG8–SG11、保留历史FAIL/CANCELLED，实际应用前不得声称权威已更新。
