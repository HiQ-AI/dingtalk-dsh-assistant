# 启动器验证，第 1 轮

2026-10-19，Windows 11 / PowerShell 7。修改前桌面 -Check 抛出 unable to open database file，堆栈指向旧 check-repair-deployment.mjs:75，固定访问退役 workflows/runtime-v2/control.sqlite。新 http.js 已将 maintenance 写接口退役为 410，排除只改数据库地址即可修复的解释。

修改后：
- 停止态真实 Check：writes=0、signals=0，31 个原生会话，ownerProcessExited=true，drained=true，unknownOperations=0、unknownNotifications=1；保留未知通知。
- node --test test/restart-web.test.js：7 tests / 7 pass / 0 fail / 0 skipped。覆盖活动账本、存活 owner、外来端口拒绝；停止态 Check 与单次启动；运行态控制台预检；原生信号退出后启动以及信号失败不启动；原生 ESM/CJS/worker 模块加载。
- 场景测试用 AST 替换外部进程调用并 mock OS/API，不是真实停机证明。真实停止态桌面入口已启动 PID 17380，后续健康证据待独立读回。
