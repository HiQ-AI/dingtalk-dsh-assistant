# 第22轮：PR #346 合并与本机部署

日期：2026-11-06

## 范围与源码绑定

本轮按授权将 PR #346 合并并部署至既有本机实例，不触发 CI/tag，不迁移 schema，不创建备份，不发真实测试消息、不重放来源、不补发通知、不修改业务账。

- PR #346 于 `2026-11-06T03:28:05Z` 合并，merge `c0cdff0123d7a5d6d245b964295926a5a8b1dd1c`，base `main`。产品提交 `8320096ae560fdd8318f6f4dda52d7530adb9adb`；合并前 PR 头为 `5b6c6f98db7778ca3491117feb2f3a9c4da8e2f4`。本轮只核对产品、测试、脚本、`.github` 与 lockfile，两者 diff 为空；不把文档提交误写为产品测试提交。
- 合并后从冻结源码重新 pack。210 个包源文件 SHA256 指纹摘要为 `939539c620933841dff585799b63f64f62a204958699fb1e337d34badd8984e9`，从打包到安装后回读未漂移。Assistant 包 SHA256 `55258971525a052a3e7e5bfa8a5c2565be139608db8c12cf24098090c4817830`（516,869 字节、96文件/93 JS），与第21轮已测包字节相同；Observer 包 SHA256 `84e114942dab9b4ef60f1b6cf9f40fae889181a5c9d52296bd778aa84d24c1f2`（62,390字节、4文件/2 JS），与第20轮已核包字节相同。包来源与逐JS比对见 `round-22/validation.json`。因此本轮未重复既有包测试。
- PR 正文由 Lead 独立回读，与本地已检查正文一致，正文 SHA256 `7550482fa17b1b10769f0d9e0490ba4497d8da4182e8fd23c30a2f9eba0eec83`。本轮没有 checks 记录。

## 部署过程与首次失败

- 首次 Check（任务 `bx6ttshiy`）为只读，writes=0、signals=0；随后部署任务 `b39zjq34d` 在 `native-dispose` 阶段以 `DEPLOY_NATIVE_NOT_QUIESCENT` 失败，安装尚未开始。首次失败字段和收据 SHA256 保留。此过程曾向旧主进程发送一次 `CTRL_C_EVENT`，当时 drain 未确认；没有第二次 signal、kill、停止订阅或取消事件。
- Lead 于 `2026-11-06T03:35:32Z` 独立核验时，旧 root PID `78868` 及大部分捕获后代已退出，但 `87988`（DWS bus）和 `89772`（conhost）仍存活。离线 current-control 为 quiescent/drained、pending tasks/executions/groups 均0，但 `ownerReleased=false`、`staleOwner=true`、`ownerProcessExited=true`、`unknownOperations=3`、`unknownNotifications=0`；未将 owner 写成已释放。在 `03:38:01.9407900Z` 观察到 DWS bus 已自然退出；这是观察时间，不是精确退出时间，没有追加信号或停止动作。
- 任务 `biavm2n5x` 对全部8个捕获 PID 和双端口做了只读复核：PID均不存在、端口空；`-ResumeNativeDispose -Check` writes=0/signals=0，current-control `candidateOnly=false`、`drained=true`、pending=0，ownerReleased/staleOwner 状态和未知计数仍按收据保留。随后任务 `bbjne709v` 使用原参数、只从安装阶段续接，exit 0；没有再次 signal。首次失败及续接链完整摘要、收据摘要见 `round-22/validation.json`。

## 安装与独立回读

- Assistant/Observer 安装包 SHA256 分别与打包产物一致，安装清单核对95/4文件。新进程 PID `42276`，创建时间 `2026-11-06T11:41:25.271212+08:00`，同属 `Running` 计划任务且 autostart enabled，同时监听 `3080` 和 `18998`。未创建备份。
- Lead 于 `03:46:06.0034523Z` 独立读取：health=`ok`、`inboundProcessing=true`、bridge healthy、`recoveryIssueCount=0`、ingress 未暂停/未恢复中；两个 listener 均 ready、backfill 均 ok。D 于 `03:46–03:48Z` 再核新进程、双端口、包摘要及9个关键模块与合并源码一致，旧 root 与捕获的7个后代均退出。
- D 于 `03:47:47.642855Z` 请求 `GET /state/recovery-issues` 得 HTTP 200，响应按数组解析为0项；第21轮旧实例曾见的 `DYNAMIC_SOURCE_STAGE_CONFLICT` 本次没有出现。D 于 `03:48:24.3380063Z` 请求 `http://127.0.0.1:3080/` 得401，符合 launcher141 的匿名根路由合同；Observer `18998` 的 readiness 与 state/tasks 查询200是不同接口，属正常。健康恢复不证明旧告警根因已修复或不会复发。
- 安装端实际导入 `decision.js` 进行纯 schema 解析：缺双数组被拒绝、显式双空可解析、wire 要求两个数组、静默理由非空、来源版本为正数。结果绑定 `installedDecisionSha256=462a5a88a577a82cd6a97a7cd17f2d68b6b8b38c49b121018031ad0a9d0b904f`。没有创建 runtime/store/provider/transport；不证明Topic覆盖、真实模型或真实消息行为。

## 配置边界与未验项

- profile patch SHA256 `1f2c3b27f47d2635c5c02c22c5965ec6c1d12b3516c86d77de7a8a4813e59f55` 与 initialized marker SHA256 `3eece5a8b4ac7dca755a7067148024172a16c81c9a2d4c31c9c44012d9d61364` 均与安装前相同；profile package.json SHA256 由 `9c186b6db4cd3e472a225b84ff751e8519d6eb265a8ec081872af31652d6ec96` 变为 `59c073b682c10dd32d830059c50193ee40e1937d1a422b391700b1484ad34a18`，由官方 add 更新。旧完整依赖/overrides 声明未保留，不能断言“整个 profile 不变”或“仅 Assistant 改变”；核验仅覆盖当前两个插件目标不可变 SHA 缓存路径。
- 部署前旧实例在 `03:30:44.7484311Z` 为 degraded、`recoveryIssueCount=1`，边界错误为 `DYNAMIC_SOURCE_STAGE_CONFLICT`。新实例回读为 ok、问题数0；旧告警与新状态之间的因果未知。第21轮记录的生产等待108.524秒与42.699秒也未由本轮部署解释。
- 本轮没有重跑Runtime/Native/Store或 release smoke；依赖是已安装包字节与既有实测包一致。第21轮 `runtime-history` 的7项失败、Store固定摘要FAIL及首次release smoke 12/14失败均保持历史记录，不因部署或健康回读变绿。
- 本轮未采样真实新消息、真实初诊/引用/steer/15条批次体验或生产60秒首回验收；`modelMode=real` 仅是配置回读，不代表本轮发生真实模型调用。仅执行部署排空控制事实检查，未逐项比对来源、任务及通知业务终态，不将部署成功等同于业务验收。

本轮归档以合并源码 `c0cdff0123d7a5d6d245b964295926a5a8b1dd1c` 及冻结实测包为依据；报告、validation、矩阵与 README 的文档改动在本次写入时尚未提交。结构化收据与必要原始收据 SHA256 见 `round-22/validation.json`。

## 证据保留与清理

本轮报告和 validation 已独立核对，16条原收据 SHA256 与两包 SHA 均匹配。随后先执行零删除 `--check`，再以固定清单摘要 `1b36938ffa2e322e70a887cb83f83b1e53d483037149c0073048afcf0ab92983` 执行 `--apply`，清理本轮 pack/evidence 两个临时目录的22文件、644,330字节；独立只读确认两目录已不存在。validation 中原附件路径仅标识已清理的源，必要字段、首次失败、续接与回读结论、原收据摘要均保留，不依赖临时附件重建结果。正式不可变安装包缓存、历史轮次报告与 validation、未知 stackdump 及私有业务证据未动，没有另建备份。
