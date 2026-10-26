# 通知来源替代与恢复计数修复

本轮复用原latency-source限定只读审查，不增成员。工程证据不构成第二份权威goal/matrix；原分析report/CSV冻结。所有写入均在合成fixture或临时原生库，无生产渠道请求。

## 复现及修复

1. 后准入B-v1被B-v2替代后，source.routed没有清processingPending；notification.start仍按pending SQL命中B-v1，永久挡住更早A的prepared通知。新增已routed/未routed两项回归均观察到`true !== false`。修复以显式supersededByVersion核同group/message/actor及已存在的递增版本，仅清旧pending，不造旧processingCompleted；新版未完成时仍拦住旧通知。已routed旧routeReceipt不可重写。
2. projectSource以前只处理未routed旧来源，且复用topic-routed命令ID；已存在成功命令收据时新参数会冲突，旧参数则只回放。现以source-superseded:<source>:<version>独立ID收束。真实native富化回归先留下旧topic-routed成功收据、再次pending，再经ingest富化到v2和recover；证明旧收据/history不变、旧pending清零、新版有独立语义完成事实、无alert和群外发。
3. unknown成功回读的reconcile缺phase，stage为attempt2而持久counter仍1；新增断言修前`1 !== 2`。补phase=readback后最终delivered、readbackAttemptCount=2、sendAttemptCount=1，不重发。

最初4项定向均失败：两项pending、一项缺新版本验证拒绝、一项计数；不是先写通过用例再声称复现。修后首次4/5通过，另一项是测试自身两个fixture ID同名冲突，改为独立index后5/5通过；再加入错误actor门禁后正式focused仍5/5通过。没有删除失败断言或降低业务门禁。

## 验证结果

| 检查 | 结果 | 本机原始证据 |
| --- | --- | --- |
| 新增缺口定向（含真实native富化） | 5 pass / 0 fail / 0 cancelled / 0 skipped | round-8/focused.log |
| 七文件HTTP/Observer/账本/来源/通知定向 | 248 pass / 0 fail / 0 cancelled / 0 skipped；16653ms | round-8/targeted.log |
| 修后完整原生四文件组合（含32代） | 72 pass / 0 fail / 0 cancelled / 0 skipped；637752ms；32代141455ms | round-8/native.log |
| pnpm test:release-smoke读取最终tgz | 14 pass / 0 fail / 0 cancelled / 0 skipped；29808ms，含真实解包个人skill任务和resident health | round-8/release-smoke.log |
| client构建及映射 | 308文件各映射一次；不是全量测试通过 | node scripts/build-web-client.mjs；node scripts/test-suites.mjs check |
| 最终三包身份 | 11个变更runtime成员与包原始字节一致 | round-8/source-sha256.json |
| 已有真Edge隔离验收 | Observer源码SHA不变，沿用round-5五项PASS、errors/writes空 | round-5/ui/browser-result.json |

计数不同组合有重叠，不相加。原始日志、包与PNG只留本机；提交脱敏汇总JSON、轮次记录和再生成脚本，不提交业务messageId、正文或本机运行快照。round-6源码包SHA是历史冻结版本；最终身份另存round-8，不覆盖历史。

## 再生成

```powershell
$env:DSH_NATIVE_TEST_PROFILE=(Resolve-Path 'test/fixtures/native-profile/package.json').Path
node --test --test-concurrency=1 test/http.test.js test/observer-client.test.js test/dynamic-task-store.test.js test/task-message-projections.test.js test/notification-pending-source.test.js test/coordination-sessions.test.js test/task-notification-delivery.test.js
node --test --test-concurrency=1 test/coordination-latency-native.test.js test/independent-coordination-native.test.js test/task-session-service-native.test.js test/task-topic-routing-native.test.js
node scripts/build-web-client.mjs
node scripts/test-suites.mjs check
$destination=(Resolve-Path 'docs/tmp/packages').Path
pnpm pack --pack-destination $destination
pnpm --dir packages/dingtalk-dsh-assistant pack --pack-destination $destination
pnpm --dir packages/dingtalk-dsh-observer pack --pack-destination $destination
$env:RELEASE_PACKAGE_DIRECTORY=$destination
pnpm test:release-smoke
```

## 交付与阻塞

- 32代根因调查和仅预算修正见round-7，正式三文件63/63通过；修后最终四文件72/72已独立回读；无loader，不以旧通过冒充最终源码。
- Git直连ls-remote已退出0，本feature远端尚无分支；gh仍明确no pull requests found。没有修改持久代理、权限或认证设置；不触发CI、不合并、不部署、不重启真实实例、不重放或外发。
- 主仓唯一权威goal/shared-tasks/matrix仍未同步；worktree隔离门禁已拒绝原根写入，未改用脚本/队友绕过。同步补丁只是待合法应用材料，不是同步完成，也不是第二份权威状态。
- 原生ListAgents独立回读：latency-data、latency-source均idle；只读复查没有新增确定反例。cc-pool list只有其他项目的6条closed历史记录，不作为本团队成员或就绪证明；本轮未open/close/clear/compact任何成员。

## 最终收尾回读

四文件命令exit0后独立读取完整日志：72 tests/72 pass/0 fail/0 cancelled/0 skipped，duration_ms=637751.6981；32代141455.452ms。各组最终汇总见`round-8/validation-summary.json`，由实际日志字段严格校验生成，不以命令成功回执代替结果。

原根Edit在2026-10-26T03:36:59.230Z及04:21:42.763Z均准确返回：

> This session is isolated in the worktree D:\project\dingtalk-dsh-assistant\.claude\worktrees\inbox-stage-timing. Edit the worktree copy of this file instead of the shared-checkout path.

`claude --help`原生支持`--add-dir <directories...>`（Additional directories to allow tool access to），但未验证其能覆盖此硬隔离；本会话无目录绑定工具，不擅自修改权限/config、不通过脚本或队友代写。仅需用户/宿主合法授权或绑定唯一验收目录，不能扩大到主仓源码；否则用户在非隔离的主仓上下文先校验再应用`docs/tmp/inbox-authority-progress.patch`。该补丁只触及原根三个文档，未实际应用不算同步完成。

## PR真实交付回读

- 代码提交：`0b71a5788c17d23db5020b6f4f400585afb49a81`，git log独立核身份/正文/署名。提交期间auto packing出现历史临时路径Filename too long警告；没有更改其数据或关闭校验，实际commit已存在。
- push前独立gh pr view确认当前正常分支no pull requests found。显式直连push失败Recv failure: Connection was reset；沿现有默认网络配置的plain git push成功，未改持久代理设置。随后plain git ls-remote独立回读远端分支同代码SHA。
- `gh pr view 260 --json number,url,state,mergedAt,headRefName,baseRefName`真实输出：`{"baseRefName":"main","headRefName":"worktree-inbox-stage-timing","mergedAt":null,"number":260,"state":"OPEN","url":"https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/260"}`。PR正文另独立回读，含248/72/14、五项Edge、基线对照及原根同步阻塞，不以创建命令成功回执代替状态。
- 没有合并、部署、重启、CI触发、真实消息重放或渠道外发。原根三个文件仍未更新；只生成三文件补丁并核numstat，不造第二份goal。
