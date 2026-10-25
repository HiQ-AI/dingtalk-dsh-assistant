## 问题与结果

PR #258 已于 2026-10-25T03:35:04Z 合并（`22d57386ebb5a11b89ab30e461a0b95e7bfc7f53`），并按后续授权完成本地 Assistant/Observer 双包部署与真实 3080 看板只读验收。本 PR 是从该 merge 新建的独立续修分支，不向已合并的 PR258 分支追加提交。

实际部署暴露了启动观察预算不足：安装收据已确认双包安装成功，但原生脚本在五分钟等待后以 `DEPLOY_NEW_PROCESS_NOT_READY` 退出。**同一新进程**随后自行达到双端口与健康就绪，未重装、未重启。这排除了“安装未完成导致无可用包”的解释，但不证明冷启动性能原因已定位。本 PR 将等待预算调整为十分钟，仍要求新 PID 同时拥有两个端口，并保留超时失败。

## 实现

- `docs/acceptance/task-session-runtime-repair/scripts/deploy-task-session-native.ps1:164`：仅将双端口等待从 300 秒增为 600 秒，不改变排空、安装、profile 校验、健康门禁或失败保护。
- `test/restart-web.test.js:7`：解析并执行生产脚本 AST 中的实际条件，覆盖预算值、拒绝旧 PID、拒绝只有一个端口、新 PID 双端口通过，以及截止超时抛错；不启动/停止计划任务或真实业务实例。
- `docs/ops/task-session-clean-start.md:66`、`README.md:308`：同步冷启动预算和失败后的只读恢复流程；先读原收据与同一进程，不能盲目重跑安装。
- `docs/acceptance/coordinator-work-visualization/scripts/native-deployment-readback.ps1:1`：固定部署身份的只读回读，核对包 SHA256、安装版本、profile、新旧 PID、双端口、自启、健康及真实 Web 认证，拒绝现场漂移。
- `docs/acceptance/coordinator-work-visualization/scripts/native-browser-acceptance.py:1`：真实宿主只读浏览器验收，不伪造 API、写业务或输出凭据；记录实际主题、错误/写请求计数与截图摘要，禁止覆盖既有结果。
- `docs/acceptance/coordinator-work-visualization/matrix.csv:13`：round-4 保留原脚本超时及浏览器遮挡失败；round-5/6 单独记录修复后验收，不改写原失败。截图只在本地保留，提交小型 JSON、摘要、脚本与说明。

## 关键实现

`docs/acceptance/task-session-runtime-repair/scripts/deploy-task-session-native.ps1:164`

```powershell
 # The installed cold profile graph can take over five minutes; retain a bounded wait.
 WaitFor {$owners=PortOwners 18998;if($owners.Count-ne1-or$owners[0]-eq$ExpectedPid){return $false};$script:newPid=$owners[0];return (PortOwners 3080)-contains$newPid} 'DEPLOY_NEW_PROCESS_NOT_READY' 600
```

这是有界观察预算修复，不是成功兜底：旧 PID 或单端口均不能通过；随后原有 transport health 检查继续执行，超时仍抛出原错误。不会自动重装、重启或重放业务。

## 验证

- [x] `node --test test/restart-web.test.js` → 本轮实跑 11/11 PASS，0 fail/cancelled/skipped；包含生产条件与超时反例。
- [x] `node scripts/test-suites.mjs check` → 308 files，每个恰好一次；historical 3、deleted 0。`git diff --check` → PASS。
- [x] 原部署先执行 `-Check`：exit0、writes0、signals0、62 sessions、unknownOperations0/unknownNotifications0。正式执行的 SIGINT/排空/双包安装收据分别留档，旧进程退出、剩余子进程0；未备份历史副本、未升级 Host。
- [x] 真实安装核对：Assistant/Observer 均为 2.1.0；Assistant SHA256 `77eea78e705ee62085afc31baab956ce2f61d2f0dc8ad09dba98c2280c0fa2a9`，Observer SHA256 `b5a468c15c4c11c757a3275887a72e8c65a2bdf438f2266f2d64514ec9f135cd`；安装白名单69/4文件已核验。profile 摘要未变，Host 仍为 0.2.1-rc.2。
- [x] `native-deployment-readback.ps1 -Check` → 2026-10-25T04:47:59Z 独立回读，同一新 PID91732 占有3080/18998、旧84680退出；health=ok、recovery0、inbound=true、自启enabled、认证Web200；writes/installs/restarts均0。
- [x] round-6 真实 3080 看板：默认浅色桌面/390px 手机各11项 PASS；18条既有协调来源、2个依赖成员、3个证明成员，真实任务详情往返、群筛选/分页、5秒轮询/手动刷新、焦点和无横向溢出；控制台/API错误及 resident 写请求均0。读取真实 SQLite/service 数据，未使用隔离 mock 代替宿主。
- [ ] 原始正式部署命令 exit1/phase=start 的失败保持原样；同进程后续就绪是独立回读，不追认原命令成功。未再执行一次600秒真实部署，避免重复停机/安装；新预算由定向测试覆盖。
- [ ] 实际安装宿主暗色未验证：持久浅色设置覆盖浏览器偏好，报告明确 actualTheme=light；未修改 Host 配置。真实模型/钉钉发送、历史通知重放、业务写入和生产空态/错误注入均未执行。

## 风险与边界

仅增加启动失败的最长观察时间，不优化冷启动，也不保证所有故障在十分钟内恢复。回退该脚本修改会恢复300秒预算，不涉及包/schema/profile迁移；如需回退已部署功能，仍走原生排空流程恢复原双包，不改账、不重放输入。PR258 的本地部署与本 PR 的源码修复分开记录。

没有手动触发 CI、推 main、强推或合并本续修 PR。原失败收据、按轮证据及未验证边界保留；正式状态以同目录 matrix.csv 为准，round-6.md 提供再生成步骤。认证日志、cookie/token、业务正文、SQLite 和 PNG 大文件不提交。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
