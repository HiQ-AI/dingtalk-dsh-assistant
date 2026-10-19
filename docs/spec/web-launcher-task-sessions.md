# Web 启动器适配任务会话运行时

桌面入口调用 DSH_HOME/launchers/restart-web.ps1，后者仍依赖退役 workflow/control.sqlite 和 maintenance 写接口。2026-10-19 Check 复现 unable to open database file，当前两端口均停止；新架构已将维护写接口置为 410。

修改既有 scripts/restart-web.ps1，复用 task-session-runtime-repair 下 inspect-quiescent-ledger.mjs 与 stop-web-console.ps1。当前本机身份沿现有部署脚本固定路径；保留 ProjectRoot 以定位仓库证据工具。停止态须只读核验任务账与 owner 已退出；运行态须先检查账本和控制台树，禁用自启、原生 CTRL+C disposal，核验精确 PID/子进程退出与离线账后再启动。拒绝活动业务，不实现强杀和旧维护兼容。

验证零写 Check、停止态真实启动、新 PID 双端口健康/匿名认证屏障、运行态 Check，以及可静止时真实重启。启动超时保留现场，禁止二次实例；不改变插件包、profile、数据或通知。同步本机已部署 launcher，SHA256 独立回读；源码在隔离分支交付。
