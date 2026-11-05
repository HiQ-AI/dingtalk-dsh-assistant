# 第20轮：SG7 本机部署与独立回读

日期：2026-11-05

## 范围与版本

本轮验证 PR #345 合并后的本机普通双包部署及安装后独立回读，不执行 schema 迁移，不发真实测试消息，不触发 CI 或 tag。

- 合并提交：`d95a2b288e987f9abbf7bd12b7cf1c9b76b30986`；PR #345 于 `2026-11-05T13:12:17Z` 合并，合并前 head 为 `e44ca763c68a4a3d8edb783202d9b5ff14defcb8`。
- 安装包源码：210 个包文件 SHA256 与第19轮已测包相等，包字节与实测产物相等，并冻结至安装后回读；本轮不重跑测试。
- Assistant 2.3.0：SHA256 `f1c926ecd6cc60d89753c2bec8280455a7deecbdf91c4d03d630d54e518560e9`，安装核对95个文件。
- Observer 2.3.0：SHA256 `84e114942dab9b4ef60f1b6cf9f40fae889181a5c9d52296bd778aa84d24c1f2`，安装核对4个文件；看板 readiness 为 ready，pendingTotal=0、taskTotal=16。该项是包/安装文件和看板 readiness 核对，不是 Observer 功能运行回归。

## 部署与运行核验

首次只读 Check 零写入、零信号，但安装流程在 `native-dispose` 阶段超时，错误为 `DEPLOY_NATIVE_NOT_QUIESCENT`；当时 autostart 已关闭，原失败收据保留。Lead 随后独立核对旧主进程及捕获后代退出、双端口关闭，并离线核验 current-control 为 quiescent/drained、pending tasks/executions/groups 均为0。此时 `ownerProcessExited=true`，但 `ownerReleased=false`、`staleOwner=true`；`unknownOperations=3`、`unknownNotifications=0`。未把 owner 未释放写作已完全释放，也未推定初次超时的具体成因。

随后使用既有 `-ResumeNativeDispose` 路径先做只读 Check，再接续原部署；无第二次 signal。新实例 PID `78868` 同时监听 `3080` 和 `18998`，health=`ok`、inbound processing=true、bridge healthy、recoveryIssueCount=0、任务状态 Running、autostart enabled。Profile SHA256 与部署前一致，initialized marker SHA256 也未变化，未创建备份。Lead 于 `13:33:56Z` 独立核对包摘要、版本、声明及运行实例相符；D 于 `13:34:17Z` 独立回读，并确认9/9个已安装功能模块与第19轮一致，没有重复完整安装扫描。

## 业务账只读回读

C 回读共16个 Task、30个 execution，均 drained；通知计数为 delivered 317、failed 3、superseded 3、starting 0、unknown 0。两个群的消息计数与部署前相同，routingPending、needsContext、ownershipUnsettled 均为0；监听器均 ready。Backfill 状态为 `ok`，同时 `backfillInProgress=true`，因此不表述为补拉已完成。

- `unknownOperations=3` 仅是数量；未验证逐条身份连续性，不据此声称三条未知操作身份均未变化。
- 历史 coordination pending 计数为10/1；不将其称为活动任务或全部排空。
- 两个先前任务身份及状态/排空情况匹配；其中首个 Task 版本从 `[4,4,80]` 到 `[6,6,100]`，变更时间未知，不归因于本次部署。
- 一条通知的状态、attempt 与身份被比对且 receipt 存在，但旧 `messageId` 连续性未证；不声称送达身份连续性已确认。
- 未检测到自然新增来源；本轮未观察真实新消息初诊、多 Topic 引用、同会话 `steer`、15条生产批次行为或首回60秒表现。

## 结论与边界

PR #345 已合并；本机普通双包切换、旧实例退出后的受控续接、安装包核对、新 PID/双端口/健康状态及独立模块回读均有记录。首次 `native-dispose` 超时及原收据保留，不由后续成功覆盖。未手改业务账、重放 ingest 或补发通知；读回计数不证明所有历史记录逐项未变。第19轮 Store 58/59 的既有摘要失败继续保留，本轮没有重跑 Store 或新增测试，也不宣称全仓全绿、真实消息验收、初诊语义验收或60秒验收通过。

完整脱敏回执、摘要、包/源码绑定与边界见 `round-20/validation.json` 及其 `originalReceiptSha256`。未写整体 `report.md`；Lead同步维护唯一Goal，源码、README和主仓未改。
## 证据保留

最终脱敏回执落盘并核对后，已通过精确文件SHA256零副作用 `--check` 后清理27份本任务中间文件：第19轮5份日志、重复候选双包及打包元数据、原始部署临时收据和4份临时日志；原生首次超时的字段和原始收据摘要保留在本轮 `validation.json`，不是抹除失败。第19轮报告、矩阵历史列及仍参与源码绑定的JSON保留。正式不可变包缓存、私有业务证据及未知stackdump未动；未建立历史备份。
