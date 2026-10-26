# 冻结实现与最终验证

本轮是工程证据快照，不是第二份可编辑 goal 或 matrix。唯一权威进度仍在原任务根，原分析 report/CSV 冻结不覆盖。以下日志均为隔离合成测试，不是线上钉钉/模型或完整安装宿主验收。

## 实质修复与反证

- `dynamic-task-store.js:1566` 保留合法但逆序的 span 起止，标 `quality=negative`；非法时间仍拒绝。重启回读断言见 `test/dynamic-task-store.test.js`，单文件106/106通过。
- 同版本重新路由按精确 activeUnitRefs 失效旧语义戳，保留 processingHistory；legacy Topic 未完成不能被协调语义戳覆盖，来源已routed也须重新拦住旧通知。
- completion race 原15秒门槛在基线也超时（15825ms）；临时60秒诊断不改断言后通过。正式用例预算改30秒，保留不重放shell效果、原执行身份和真实核验断言，无loader正式通过（16979ms）。不将放宽门槛解释为性能改善。
- 首轮三文件63 tests中38 fail及round-4中途停止日志保留，不能拿局部成功覆盖整个组合；本轮完整三文件组合63 tests / 62 pass / 0 fail / 1 cancelled / 0 skipped，唯一取消仍是32 continuations（121027ms，原120000ms deadline），不能标全绿。

## 已回读的结果

| 检查 | 实际结果 | 本机原始证据 |
| --- | --- | --- |
| HTTP/Observer/store/DTO/pending-source/session/notification定向组合，完整原生依赖 | 244 pass / 0 fail / 0 skipped | `round-6/targeted.log` |
| Topic、混合来源、Host blocked与原生归类 | 11 pass / 0 fail / 0 skipped | `round-6/topic-native.log` |
| 协调契约、17/41目录分页、重试澄清、完成竞态和跨成员续办 | 6 pass / 0 fail / 0 skipped | `round-6/contract-native.log` |
| release构件/工作流等相关检查 | 12 pass / 0 fail / 0 skipped | `round-5/release.log` |
| 冻结源码三包构建及真实解包启动、个人skill任务 | 2 pass / 0 fail / 0 skipped | `round-6/pack.log`、`round-6/package-native.log` |
| 真Edge隔离浏览器 | 5 checks PASS；errors/writes均空 | `round-5/ui/browser-result.json` |

不同组合包含重复用例，禁止把数量直接相加当独立覆盖数。原始日志和PNG留本机，不进入PR；本文件、脱敏JSON与脚本用于公开审阅和再生成。

## 再生成命令

先以 `DSH_NATIVE_TEST_PROFILE` 显式指定已有完整原生依赖的 package.json（只解析依赖，不加载运行库/配置），所有临时库和shell效果均由fixture在临时目录创建。

```powershell
node --test --test-concurrency=1 test/http.test.js test/observer-client.test.js test/dynamic-task-store.test.js test/task-message-projections.test.js test/notification-pending-source.test.js test/coordination-sessions.test.js test/task-notification-delivery.test.js
node --test --test-concurrency=1 test/coordination-latency-native.test.js test/task-topic-routing-native.test.js
node --test --test-concurrency=1 --test-name-pattern='coordination context|read-only scheduling|successful clarification|native completion race|不同群成员续办' test/independent-coordination-native.test.js test/task-session-service-native.test.js
node scripts/build-web-client.mjs
node scripts/test-suites.mjs check
```

最后一项是308文件分类守恒，不是全量测试。三包按 `docs/ops/npm-release.md` 的本地pack配方生成到 `docs/tmp/packages`（没有publish）；设置 `RELEASE_PACKAGE_DIRECTORY` 后运行 `node --test test/task-session-package-native.test.js`。最终11个变更runtime成员与对应tgz的原始字节一致，三个包大小/SHA及源码SHA见 `round-6/source-sha256.json`，不是对中途包的口头引用。

浏览器命令与round-5相同，参数显式传匹配ReactDOM 18.3.1与Playwright入口；Edge156.0.4314.42，Observer SHA为 `7fd401998f7df6671a40d7e9edc713923ab7c5002bdfb6c3345f618ca8f913d3`。使用完整Observer、真实HTTP handler/React/ReactDOM及随机loopback server；Host slots/primitives是适配替身，外部origin与写请求禁止。

## 当前真实边界

- worktree `.claude/worktrees/inbox-stage-timing`，分支 `worktree-inbox-stage-timing`，base `0535038267adb31e710b87ef8b02a55cce9f3e8a`。主检出代码未改。
- 最近原生ListAgents：latency-data和latency-source均idle；已收到latency-data最终冻结文字交接，不再修改文件。未新开成员、未close/clear/compact现有成员，cc-pool不用于接管原生in-process团队。
- 唯一权威goal/shared-tasks/matrix仍陈旧。此前Edit原任务根遭隔离门禁拒绝，未改用shell或队友绕过，也未另建goal/matrix冒充已更新。该要求仍未完成。
- GitHub经本机loopback代理曾TLS超时；单命令直连API已恢复，gh明确返回本分支no pull requests found，Git远程仍Connection reset。未修改持久代理/认证设置。当前未push/创建PR，先定位32续办，不将API恢复等同Git push可用。
- 未合并、未部署、未重启、未重放真实消息、未外发通知、未运行生产模型或生产性能对比。workflow只接受tag/manual，本轮不触发CI。

## 32续办完整基线对照

不再以指定模块loader作为完整基线。`git archive 0535038` 导出全部源码，独立 `pnpm --dir docs/tmp/inbox-clean-base-0535038 install --frozen-lockfile`（453包），不链接主检出依赖；以该目录自己的native profile直接执行原测试/原fixture，未使用loader、未修改超时或断言。

```powershell
$env:DSH_NATIVE_TEST_PROFILE=(Resolve-Path 'docs/tmp/inbox-clean-base-0535038/test/fixtures/native-profile/package.json').Path
node --test --test-name-pattern='32 continuations bound owner Host input' docs/tmp/inbox-clean-base-0535038/test/task-session-service-native.test.js
```

结果：0 pass / 0 fail / 1 cancelled / 0 skipped，121486ms，同一120000ms deadline。全部3314个版本库文件逐个核验：81个原始Git blob一致、3233个只有Git Windows LF→CRLF变换，未修改任何语义内容；见 `round-6/clean-base-proof.json`。不能称原始LF字节全相同。

该对照证明基线原用例在本环境也超时，但仅凭两次deadline仍不能量化有无新增性能退化。下一步使用保留全部断言的临时诊断loader，扩大观察窗口并记录每代进展，区分死循环/阻塞与单纯总预算；诊断结果不直接计为正式PASS。

另补负时回归缺口：同span先写open、再更新negative、重启回读原始时刻与quality，定向1/1 PASS，无生产改动。
