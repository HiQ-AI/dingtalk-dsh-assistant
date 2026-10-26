## 本轮：前置正式完成 → 目标调度关系

继续原 PR259 / `worktree-coordinator-work-deployment`，保持 OPEN、不合并。先前实体台账和启动等待300→600秒修复保留；本轮不改持久状态机、不迁移 schema、不升级 Host。

### 改了什么、为什么

- `packages/dingtalk-dsh-assistant/coordination-observer.js:103`：新增每目标指令一条关系，具体前置任务 → 目标任务，条件只认现有 `all`。完整跨 trigger/coordination 集合先解析再分页/截断；当前版本正式前置证明与控制态决定等待，不借 B active/fulfilled/completed 证明调度。
- `packages/dingtalk-dsh-assistant/coordination-observer.js:128`：成功只认冻结 command ID 查询的持久 receipt，task ID 和四版本必须匹配；occurrence 实体还要求本次记录匹配 instruction/command，不能借其他 trigger 成功/失败。真实 waiting、pending、dispatched、failed、cancelled、paused、stale、blocked、unknown 分开；既有精确接纳不被 B 后续执行或 A 新版本抹掉。
- `packages/dingtalk-dsh-assistant/coordination-observer.js:319`：B 任务页按实际 occurrence 接纳时间选同关系的最新安排，不再依赖含 B 更新时间的 work 排序。旧取消/新成功、旧成功/新取消及输入反序、ID排序均有反例回归。
- `packages/dingtalk-dsh-assistant/task-session-service.js:387`、`packages/dingtalk-dsh-observer/web-client.js:542`：现有 task detail 增加只读 `coordination`；协调页和 B 页复用同一关系展示。B 等待时只列真实未满足前置，可点击 A；具体任务名、条件、结果、原因、真实下一步及目标链接优先。移除把内部 proof 句子当下一动作和把 B 执行/完成当协调结果的展示，proof 留在折叠证据。
- `packages/dingtalk-dsh-assistant/coordination-observer.js:311`、`packages/dingtalk-dsh-observer/web-client.js:625`、`packages/dingtalk-dsh-assistant/coordination-observer.js:196`：修复合法 opaque ID 编码往返、once 按计划时区显示、取消发生在 notification.start 之前时误报成功/发送失败。真实已发生发送结果仍保留。
- `test/coordination-observer.test.js:530`、`test/coordination-observer.test.js:732`、`test/coordination-observer.test.js:942`、`test/observer-node-control-display.test.js:698`：正式 SQLite/HTTP/命令链、receipt归属、控制/版本/重复触发/任务页选择、只读守恒、UI等待和时区回归。README、API、设计合同与 ops 同步。

### 本地实跑，不是 CI

- 最终定向 **164 PASS / 0 FAIL / 0 SKIP**：`node --test test/coordination-observer.test.js test/observer-node-control-display.test.js test/task-session-http-integration.test.js test/coordination-ledger.test.js test/coordination-execution-proof.test.js test/coordination-trigger-commands.test.js test/coordination-observed-prerequisites.test.js`。
- 风险 **135 PASS / 0 FAIL / 0 SKIP**：`node --test test/coordination-time.test.js test/coordination-trigger-commands.test.js test/coordination-schedule-revisions.test.js test/coordination-observed-prerequisites.test.js test/coordination-effective-graph.test.js test/coordination-concurrency-contracts.test.js test/coordination-notification-freshness.test.js test/observer-client.test.js test/observer-slot-compatibility.test.js test/observer-archive-interaction.test.js test/observer-board-restoration.test.js test/restart-web.test.js test/test-suite-contracts.test.js`。
- 最终冻结包发布冒烟 **14 PASS / 0 FAIL / 0 SKIP**：显式 `DSH_NATIVE_TEST_PROFILE=D:/dsh_home/profiles/web/package.json`、`RELEASE_PACKAGE_DIRECTORY=D:/dsh_home/packages/coordinator-dispatch-relations-20261025`，执行 `node --test --test-concurrency=1 test/release-workflow.test.js test/release-artifacts.test.js test/task-session-package-native.test.js`；实际解包并运行原生 task/service。早先默认12PASS/2SKIP和一次30秒 timeout 保留在round34，不算最终通过。
- `node scripts/test-suites.mjs check`：308文件，每个恰好一次，historical3/deleted0。真实 service import 使 observer test 从 unit→compat，后续187项 lane 为确定性轮换；无测试退出release。源码语法、Python AST、diff检查通过。
- round36 最终产品源码的隔离真实 SQLite/production HTTP/React18/primitives：桌面、390px浅色/真暗色、forced-colors四变体各9PASS。实际 waiting A、A正式完成/B待调度、receipt接纳B、B页等待且点击A、筛群/空群/刷新/返回/focus和十种提醒状态均覆盖。最小ModuleLoader/slots适配器不是完整原生Host。

### 原生部署和实际 3080

按 runbook 先 Check：零写入/零信号、62会话排空、unknown operations/notifications均0。随后一次原生 SIGINT 排空安装；旧owner进程退出、残留子进程0，保留stale owner元数据，不冒称 ownerReleased。

最终包目录 `D:/dsh_home/packages/coordinator-dispatch-relations-20261025`：

- Assistant2.1.0，396028字节，SHA256 `0155343482f9a9c9c2418e1dec10ab123866310587c3fd4283a1764c75318c7e`。
- Observer2.1.0，59781字节，SHA256 `df12db71653213b1afe97c9b36a23c2037c808ad4f9b3cc0336b64a6f237b826`。
- 独立核验69+4白名单文件；Assistant archive另自动包含README，共70项。packageJSON语义比较，运行源码逐字节/hash匹配。
- 独立原生读回 `round-36/native-independent-readback.json`：旧91256退出，新93604同时监听3080/18998；profileSHA `74fe100c0019f5e4c76c06903fdb622b0af5696afc60ab38cbd252ce8f948499`、Host0.2.1-rc.2不变。自启enabled/running，health ok/recovery0/inbound true，bridge healthy/listeners ready/backfills ok，认证Web200。
- 现场18条历史输入投影10个唯一实体（7schedule+3trigger）；原失败提醒仍主显“提醒发送失败”，无虚构下次或重试。两条真实跨trigger依赖各为dispatched/accepted，目标页同态且HTTP200；不是从B完成状态反推。

最终 **round39** 在已安装3080四变体各7PASS：首群/显式全部、手动+5秒刷新、任务返回/焦点/选择、关系和目标页、390px无横溢出；console/page/API错误和resident写请求0。16组当前source/driver摘要、28PNG字节/hash独立匹配。亲自查看完整桌面和手机关系区，箭头、all条件、结果和下一步可读；真实任务名脱敏。截图只本地保留、不入git：

- `docs/acceptance/coordinator-work-visualization/round-39/after-desktop-light-native-relation-2-detail.png`
- `docs/acceptance/coordinator-work-visualization/round-39/after-mobile-light-native-relation-1-detail.png`
- 等待态看隔离实测 `docs/acceptance/coordinator-work-visualization/round-36/after-mobile-light-task-waits-for-prerequisite.png`，不冒充生产截图。

### 审查、失败和明确盲点

- 原只读reviewer发现跨trigger结果泄漏、trigger门禁、关系标题、receipt归属和任务页first-wins；后端修复。reviewer在最终去重源码增量实跑2个反例PASS，不声称独立跑完164/135或原生浏览器。用户要求low，但后端实际env报告high、lead env null，未更改harness配置，不冒称实际推理effort。
- round33 ID/浏览器、round35 first-wins FAIL保留；round37功能PASS但Host更新提示遮截图、round38手机视口未包含完整关系区，均记视觉FAIL。仅修验收驱动：普通点击稍后提醒、截图前断言提示消失、补完整关系元素截图；新round39通过，不覆盖失败，不改产品源码/宿主设置。
- 官方stale拒绝会事务回滚，真实已验证stale/absent及无目标变更；没有官方持久化通用failed receipt链。failed/unknown投影仅纯query覆盖，不能声称官方失败持久链或原生调度失败已验证。
- 原生没有waiting/failed-dispatch样本，不造生产夹具；waiting→pending→dispatch由隔离正式命令/真实浏览器验证。原生dark偏好仍实际浅色，不算原生暗色通过；真正暗色由隔离环境验证。
- 全程不发钉钉测试消息、不重放历史通知、不手改业务库、不迁移schema、不升级Host、不触发CI、不强推、不推main、不合并259。自有隔离5452已停止，19087/19088无监听，原生93604不受影响。唯一goal/shared-tasks/matrix及round证据同根；不相加历史中间测试数。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
