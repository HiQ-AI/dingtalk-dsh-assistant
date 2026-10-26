## 问题与结果

群摘要主动省略 topics，但旧收信箱仍按 `selectedGroup.topics` 判断是否完成：没有话题数据反而将 routed 的未完成消息显示为“已处理”。旧时间口径只支持 Topic，不能解释新来源语义状态或历史空窗。

本 PR 将当前消息版本状态移至拥有来源/Topic账的后端；语义完成、业务任务完成、来源收束和通知回读彼此独立。补无正文阶段时钟并在现有表格的原生 details 展示，保留未知/缺时/负值。不是并发优化，也不承诺线上提速。

## 实现

- `http.js` 以 group/message/version 唯一匹配来源、核 activeUnitRefs 精确集合与旧 Topic 每 unit 最新 entry；Topic 未完成不能被提前语义戳覆盖。多个 Topic 取最晚有效完成时间，旧版本关联不进入当前 topicRefs；来源读失败返回503，不把故障当空数据成功。
- `dynamic-task-store.js` / `task-session-service.js` 复用现有 JSON 来源/通知事实；同版重新路由使旧语义戳失效，保留历史、重新拦住旧回复，不等待业务 settled。旧版被新版本替代时核同群同消息同actor后只清pending，保留原路由收据、不造完成戳，独立命令ID避开旧成功收据。追加接收、收束、ACK与真实回读送达时间。
- 协调会话、独立协调及通知在真正拥有的 `ingress/queue/turn/host/send/readback` 边界记录 span/request/attempt/session；多 turn 分开、不跨会话取包络，共享区间不累计。重启后没有结束证据的 span 保持 open，不补造时钟。unknown恢复成功回读补计数，发送次数不变。
- `task-message-projections.js` 仅 allowlist 投影无正文、无actor/凭据的 DTO。通知须精确版本绑定且全部回读才有 E2E；历史无版本通知仍可读，但不能完成当前版本E2E。
- Observer 不再由空 topics 或 routed 推断成功；保留现有表格、状态组件及窄屏横向阅读。未知行辅助文本同样中立；native details 支持键盘开合、显示缺失阶段与共享区间。
- README、设计合同和本地部署说明同步；不新增 SQL schema、不回填历史、不重放消息。

## 关键实现

`packages/dingtalk-dsh-assistant/http.js:98`

```javascript
  const refsKey = refs => refs.map(ref => JSON.stringify([ref.unitId, ref.unitRevision])).sort()
  const sourceDone = !!source?.processingCompleted && (!Array.isArray(message.activeUnitRefs)
    || Array.isArray(source.processingCompleted.activeUnitRefs)
      && JSON.stringify(refsKey(message.activeUnitRefs)) === JSON.stringify(refsKey(source.processingCompleted.activeUnitRefs)))
```

同 messageVersion 也能重路由产生新 unitRevision，所以不能只检查 processingCompleted 存在或群 routingRevision。

`packages/dingtalk-dsh-assistant/http.js:118`

```javascript
  const notices = source?.notifications ?? []
  const noticeTimes = notices.map(notice => notice.deliveredAt)
  const deliveredAt = notices.length && notices.every(notice => notice.versionMatched === true && notice.state === 'delivered') && noticeTimes.every(time => Number.isFinite(instant(time)))
    ? new Date(Math.max(...noticeTimes.map(instant))).toISOString() : null
```

未核版本、仅 ACK、未全部回读或缺时均不能制造 E2E 成功；外发通知也不延长语义完成时间。

## 验证

- [x] 已有修复核验：`4444f6a`、`3d9c85e` 为实施基线 `0535038` 祖先；六目标文件 archive 与已安装包原始字节相同，与基线经 LF→CRLF 后一致（不是 Git blob 原始字节同一）。只证明已安装旧修复，不代表本 PR 已部署。
- [x] `node --test --test-concurrency=1 test/http.test.js test/observer-client.test.js test/dynamic-task-store.test.js test/task-message-projections.test.js test/notification-pending-source.test.js test/coordination-sessions.test.js test/task-notification-delivery.test.js` → 最终248 pass、0 fail、0 skipped（含完整原生依赖）；覆盖来源重放、重启open span、同版新unitRevision、负时持久化、通知回读与DTO隐私；包含旧版本pending退役和成功恢复回读计数回归。中间轮241 pass/2 skip不是最终结果。
- [x] `node docs/acceptance/inbox-latency-week-20261019/scripts/verify-inbox-browser.mjs --root . --output <evidence-dir> --react-dom <react-dom-18.3.1-directory> --playwright <playwright-index.mjs>` → 修前复现两条假成功；修后Edge156五项通过（状态、事实、键盘、筛选、刷新），errors/writes均空。Observer SHA `7fd401998f7df6671a40d7e9edc713923ab7c5002bdfb6c3345f618ca8f913d3`。已目视桌面/窄屏与展开详情；宿主适配不等于完整安装宿主验收。
- [x] `node scripts/build-web-client.mjs` + 生成文件差异断言；`node scripts/test-suites.mjs check` → 构建输出未漂移，308文件映射各一次（不是全量测试）。
- [x] 完整原生profile下定向Topic/混合来源11/11、协调契约/续办/完成竞态6/6、release相关12/12、最终三包构建及实际解包运行2/2，均0 fail/0 skipped；见round-6。竞态在base也超过旧15s门槛，保留全部业务断言并改为30s后正式无loader通过，不把延时诊断代替正式回归。
- [x] 32代超时完整基线对照：完整0535038原测试也超原120秒；保留全部断言诊断current139s/base145s均通过，不是性能基准。仅将原用例预算120→240s后，无loader原三文件正式63/63、0 cancelled。修后无loader完整四文件72/72、0 fail/cancel/skip，duration_ms=637751.6981（32代141455ms），包含Topic富化/路由、跨成员续办、shell未知效果、恢复/公平续行。见round-8/validation-summary.json。
- [x] 最终tgz的 `pnpm test:release-smoke` →14/14、0 fail/cancel/skip，含真实解包个人skill任务与resident health；最终11个runtime字节与三包SHA见round-8/source-sha256.json。
- 未运行生产钉钉新消息、真实模型或线上性能对比。2026-10-26 新阶段已授权审查、确认后合并及受控部署；消息重放和向同事外发仍未授权。部署与安装功能验证必须另有本轮实证，不能用本节测试冒称已部署。

证据见 `docs/acceptance/inbox-latency-week-20261019/round-1.md`、`docs/acceptance/inbox-latency-week-20261019/round-4.md`、`docs/acceptance/inbox-latency-week-20261019/round-5.md`、`docs/acceptance/inbox-latency-week-20261019/round-6.md`、`docs/acceptance/inbox-latency-week-20261019/round-7.md`、`docs/acceptance/inbox-latency-week-20261019/round-8.md`；失败历史保留，不凑全绿。原分析报告/CSV及业务消息ID不提交。

## 本轮独立审查与修复（round-9）

- 确认并修复一个 P2：`independent-coordination-service.js:560-562` 的 queue 计数为 ledger.attemptCount，而 `independent-coordination-planner.js:152,168` 的 turn/host 原用 generation。同 generation 重试只增 attemptCount，原阶段计数错配。现在 planner 显式接收账本 attempt，generation/fence/来源版本规则不变。
- `test/independent-coordination-native.test.js:89-100` 在实际首次未提交→5000ms退避→澄清成功的既有原生用例补首轮全部0、重试 queue/turn/host 全部1及span独立断言。修前实跑1 FAIL（实际[0,1] vs预期[0]），修后1/1 PASS。
- 修后三文件 `node --test --test-concurrency=1 test/independent-coordination-native.test.js test/coordination-sessions.test.js test/task-message-projections.test.js`：46/46、0 fail/cancel/skip；最终三包 `pnpm test:release-smoke`：14/14、0 fail/cancel/skip。未重跑无关全量或32代诊断，旧失败历史保留。
- 原 latency-data 与 latency-source 对本轮修复分别只读复核，确认计数贯通且状态/版本/隐私无新增确定反例；不是沿用旧finished报告。真实Edge隔离浏览器再跑五项PASS、errors/writes空。
- `scripts/verify-inbox-browser.mjs` 新增 `--installed-profile` 显式加载已安装双包，在隔离fixture中验安装代码；默认路径已再次实跑。实际安装后另跑该模式，不以worktree模式冒称安装验收。
- 原生静止检查 exit1 / DEPLOY_NOT_DRAINED：现场有真实未结束统筹/执行回合及starting操作。未切包或停实例；必须自然排空及原生双包脚本Check通过后才部署。旧workflow maintenance不可用不得Bootstrap绕过。

脱敏结果与复核时间见 `docs/acceptance/inbox-latency-week-20261019/round-9.md`、`round-9/validation-summary.json`。包/源码逐文件核：Assistant 69文件、Observer 4文件一致。失败是安全门禁命中，不假称已修成PASS。

## 风险与边界

- 仅用于未来可观察事实，不把历史最大空窗归因为排队或模型；入口是插件 ingest 入口，不是钉钉服务器或网络接收时间。原生 turn 含模型、工具、Host，不是纯模型推理。
- 对旧服务缺字段安全降级未知；双包应按运维runbook协同升级。回滚恢复旧双包，不删新增账、不重放已完成或未知效果。
- 无SQL schema迁移。所有测试写入只在合成/临时库；读取安装profile只用于解析原生依赖，没有修改运行配置、生产数据或进程。
- 唯一权威goal/shared-tasks/matrix在原任务根；此前三文件补丁已由用户授权Codex合法应用并独立核实。worktree不绕过隔离门禁，不维护第二份可编辑权威目标；本轮新进展仍按原根合法同步路径交付。
- 普通分支与PR不触发 CI（现有workflow仅tag/manual），本轮不手动dispatch/re-run；空statusCheckRollup不是CI通过。审查、合并、部署各层单独回读，不作线上提速声明。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
