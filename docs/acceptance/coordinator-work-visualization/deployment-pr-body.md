## 本轮改动

续修 PR258 合并后的独立开发线；本 PR **保持 OPEN，不合并**。本轮按用户 UI 反馈继续 PR259，不向已合并 PR258 追加提交。原启动预算修复和历史部署证据保留。

- `packages/dingtalk-dsh-observer/web-client.js:568`：默认按既有顺序选首个有效群；区分群加载与空群，首群就绪前不读取全部；保序去重、失效范围清理、显式全部、手选/轮询/刷新/任务返回保持。
- `packages/dingtalk-dsh-observer/web-client.js:130`：协调列表改为67px紧凑双行；柔和选中底色、2px细标识、独立focus-visible；forced-colors使用Highlight实体边条；全部群模式保留来源群以区分同文输入。
- `packages/dingtalk-dsh-observer/web-client.js:626`：先展示真实定时状态/下次触发/周期，或任务状态/依赖/阻塞/已记录下一动作；历史结论独立命名，不伪造成未来动作。原始输入/历史/证据折叠，空section隐藏，接纳/送达/正式完成保持独立。
- `test/observer-node-control-display.test.js:548`：补异步首群、空群/失效、显式全部/重排刷新、定时重点、跨群同文与历史结论回归。README和设计合同同步。
- 原续修 `docs/acceptance/task-session-runtime-repair/scripts/deploy-task-session-native.ps1:164` 将启动观察预算300->600秒，仍拒绝旧PID/单端口、保留超时失败；相关生产AST测试11/11通过。

## 本地实跑证据

- 最终命令：`node --test test/coordination-observer.test.js test/observer-client.test.js test/observer-slot-compatibility.test.js test/observer-board-restoration.test.js test/observer-archive-interaction.test.js test/observer-node-control-display.test.js test/restart-web.test.js` → **101/101 PASS**，0 fail/cancel/skip。此前round11风险回归136/136独立留档，不混算。
- `node scripts/test-suites.mjs check` → 308 files，每个恰好一次；`node --check packages/dingtalk-dsh-observer/web-client.js`与`git diff --check`通过。
- round11真实源码隔离React/primitives/HTTP/SQLite/任务服务五变体UI断言通过；不是完整安装宿主证明。旧驱动未监听隔离API19088，故其零流量计数不作证明；已改用显式--api端口并用18998/19088真实驱动AST检查2/2PASS。真实round16的18998监控不受影响。原生low队友发现的群归属、历史结论误标与高对比盲点已修复；队友最终回读并实跑新增断言1/1 PASS。
- round16在**真实已安装3080宿主**运行桌面/390px、light/dark偏好、高对比五变体，每种7项PASS：首群无all请求，真实定时重点，跨群任务服务HTTP200/往返，焦点，手选后手动/5秒刷新保持，无横向溢出。console/API错误/resident写请求均0。
- 同尺寸真实前后：桌面1440x1000 **5→10条**，手机390x844 **4→8条**，行高111–153px→67px。五份JSON source hash与当前源码一致，20张截图bytes/SHA全部独立MATCH；截图脱敏且仅本地保留。

## 已授权候选本地部署

先Check：writes0/signals0、62会话排空、unknown operations/notifications0。冻结最终双包后仅安装一次，部署命令exit0；独立`candidate-deployment-readback.ps1 -Check`确认：

- Assistant/Observer均2.1.0；Assistant SHA256 `043b065f558be0de0c9deacab1f1caf54f0cf3b1db959ba55a0c68965339088d`；Observer `fa55a28849bc894fdd4e44b63e2d6cd4ae914675eb528dbca07a63b641ee35a4`。
- 旧91732退出，新45548同时占有3080/18998；profileSHA `74fe100c0019f5e4c76c06903fdb622b0af5696afc60ab38cbd252ce8f948499`未变，Host仍0.2.1-rc.2；自启enabled/running，health ok/recovery0/inbound true，listeners ready/backfills ok，认证Web200，既有来源18条。
- 独立回读writes/installs/restarts0只描述该次回读，不否认此前安装。原始含群标识健康收据本地忽略，提交aggregate candidate-readback.json。

## 保留失败与未验证边界

- 原round4五分钟部署超时保持FAIL，未追认成功。当前候选一次正式部署成功另记round12。
- round8 favicon失败、round12/13/15浏览器失败全部保留；后者由真实Codex Connect更新提示拦截点击，round15还暴露驱动退出上下文后查询错误。驱动改为Playwright原生locator handler点击真实“稍后提醒”；不强制穿透、不移除DOM、不改Host配置。round16另起新轮全通过。
- **真实安装暗色仍未验证**：Host持久浅色覆盖浏览器偏好；不把dark请求当dark证明。源码隔离暗色单独通过。release smoke此前12 PASS+2 SKIP，缺完整native profile的dsh-base，不声称14 PASS。
- 未进行真实模型推理、钉钉测试发送、通知重放、业务写入或生产故障/空态注入；未升级无关Host/插件。无schema迁移；回退仍按原生排空runbook恢复双包，不改账或重放输入。
- 唯一进度/证据在`docs/acceptance/coordinator-work-visualization/goal.md`、`shared-tasks.md`、`matrix.csv`和各round；round16为本轮最终功能证据。未触发CI、未强推、未推main、未合并本PR。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
