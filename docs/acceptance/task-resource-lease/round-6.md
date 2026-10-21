# 本地受控安装与独立回读

2026-10-21 09:43:56 +08:00 独立回读通过。沿 `docs/acceptance/task-session-runtime-repair/scripts/deploy-task-session-native.ps1`，先运行 `-Check`，再使用相同精确包、profile hash、旧 PID 和新证据目录正式切换。Check 报 writes=0/signals=0；48 个相关会话静止，unknown operation/notification 均 0。

| 对象 | 独立结果 |
|---|---|
| Assistant 2.0.2 tarball | 278462 bytes；SHA256 `32415f7ca9fa90a181e74b44772a5f8fb25d06effc54a9b456d247e5c26239b5`；安装脚本核对 54 个包文件 |
| Observer 2.0.2 tarball | 51512 bytes；SHA256 `50e635d537a234af2a03ef6d5063a06a55b09111ccee920583606700d0fe1044`；沿双包安装入口同步精确安装，未改 Observer 源码 |
| 实际资源模块 | 源码与安装目录 SHA256 均 `08e1659fbfc57d1d856f948ae76e831599273c85b1ee03f7c707224bbd5086e1` |
| 原生退出与新进程 | 旧 PID 56680 已退出；新 PID 73660 独占 3080/18998，已恢复既有自启；未创建历史备份 |
| 健康与边界 | health=ok；recoveryIssueCount=0；inboundProcessing=true；dwsBridge.healthy=true；匿名 Web=401 |
| profile | SHA256 仍为 `fb0a6a410c0d9efb4c311c760457efc80f9087b8fb8343f403ccbaf1748bfbfa` |

冷启动约四分钟，在既有五分钟有界等待内完成；未重复安装、另起实例或强制终止。未改真实任务 SQLite，也未重放历史业务或发送验证消息。

安装后将 `test/dynamic-execution-resources.test.js` 仅替换被测 import 为安装目录的 `dynamic-task-store.js`，生成现场 `round-6/installed-resources.test.mjs`；以 `node --test` 运行仍使用临时隔离账本，17 PASS、0 FAIL/CANCELLED/SKIP。其中六次公开资源查询均只读一次锁表。这证明安装文件具备行为，不把源码测试或进程健康替代该证据。

再生成入口：分别用 `pnpm --dir packages/dingtalk-dsh-assistant pack --pack-destination <输出目录>` 和 Observer 对应命令打包；独立取包 SHA256、profile SHA256、旧实例 PID，按现有原生部署脚本参数与 `-Check` 执行。禁止复用本轮旧 PID 或假设以后包 hash 相同。原始包、检查/退出/安装/回读 JSON 与测试日志保留在被忽略的 `round-6/`，不进入版本库。

这是当前本机修复包，无 npm 发布；真实 UAT 业务部署和实际模型长期遵守 skill 的效果不在此验收范围。
