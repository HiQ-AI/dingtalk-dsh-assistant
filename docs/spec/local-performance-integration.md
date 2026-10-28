# 本地性能改进与验证边界

本轮同时整合启动、看板真分页和任务目录详情存储。基线为 main `644ff90c694e19f661177ffd7b5e595d452a9fae`（包含#272）；运行时代码检查点为 `891b2e6764526acd43da7052b69c409f06620bbf`。只提交draft PR，未部署、迁移或删除真实数据；原分页worktree和交付补丁继续保留。

## 行为与读取边界

| 路径 | 本次行为 | 核心证据 |
|---|---|---|
| 启动 | 必要完整性检查在只读worker运行，仍先校验再恢复；复用恢复记录并输出阶段耗时 | 32MiB合成数据校验期间Host timer仍推进；损坏与外键错误拒绝打开 |
| 任务、执行、授权页 | 存储层先选ID，再恢复本页完整详情；执行摘要不读取详情 | SQL页读取量、稳定排序、数据变化409、页内授权/通知身份 |
| 群消息、outbox、主题/上下文、协作、告警 | 元数据索引与页内正文分离；trace协调单元独立续读 | 群消息页内ID、SQL/内存边界、superseded过滤与100+单元续读 |
| 文件与证据 | 有界派生块、摘要及账本绑定，不为一页读取完整原始JSON | Unicode、错绑/篡改拒绝、离线有界迁移 |
| 控制数据库 | 任务/协作目录存完整详情，中央保留控制状态与投影；维护轮询不追加永久noop回执 | 持久化、重复命令、重启、缺失/损坏详情、未知效果不重放 |
| 详情路径检查 | 重叠祖先不反复realpath；同一同步查询复用已校验的所有者句柄，下次查询重新校验 | 保留祖先链接、inode、记录身份与每个对象摘要验证 |

首次群元数据仍可为O(N)，常驻消息尚是内存模型；不承诺所有首次读取或启动缓存与历史规模无关。详情外置也有额外IO成本。

## 最终按用户要求执行的核心验证

用户09:41明确要求精简内部流程/计时夹具，不再以完整历史native/compat/history全绿作为PR前置。最终核心集合328/328，原生结果4/4，发布烟测14/14，均零跳过。

```powershell
$env:DSH_NATIVE_TEST_PROFILE = Join-Path (Get-Location) 'test/fixtures/native-profile/package.json'
node --test --test-concurrency=1 `
  test/dynamic-task-store.test.js test/task-ledger-details.test.js `
  test/observer-pagination.test.js test/observer-group-pages.test.js `
  test/observer-file-pages.test.js test/observer-trace-pages.test.js `
  test/observer-pagination-migration.test.js test/observer-legacy-execution-pages.test.js `
  test/task-startup-performance.test.js test/http.test.js test/observer-client.test.js `
  test/task-topic-context-http.test.js test/task-message-projections.test.js `
  test/coordination-fairness-native.test.js test/task-operator-notification-scan.test.js
node --test --test-name-pattern 'native queued members complete once|native service cancellation stops the real execution process|empty owner recovery reviews the retained execution|resource read retries preserve image facts' test/task-session-service-native.test.js
pnpm test:release-smoke
node scripts/test-suites.mjs check
```

Windows测试使用既有短临时目录和授权执行上下文，没有修改ACL或全局safe.directory。映射323文件、历史3、删除文件0；本次有意删除了下面列出的内部流程测试，不能将“删除文件0”解释为未删测试案例。

原始日志位于本地 `scratch/integration-evidence/`：`final-core-results.log`、`final-native-outcomes.log`、`final-release-smoke-core-scope.log`。测试时运行时代码与上述检查点一致；后续说明文档不改变运行时代码或发布清单。

## 精简与保留

- 删除公平性文件中两组手工gate及精确step序列夹具；保留真实恢复和不重复效果的结果检查。
- 公平性42排程缩为6个，去掉“恢复瞬间恰好20项”的内部批次断言；保留阻塞/成功结果、跨安排跨群推进、重启job身份与attempt不重复。
- 原11成员压力流程缩为3成员，仍跨越并发配额2，验证排队、文件读回、全部完成和身份/操作数量；超过10执行身份的持久化仍由账本测试覆盖。
- 资源入站去掉精确phase顺序、loopDelay临时数值和异步queue未落稳时整数组比较；保留重试、新来源、图片事实、重复来源复用与不重复读取/入账。
- 资源目录缺失mock返回真实契约null，保留通知不重复发送、送达与撤回结果；未放松生产资源身份校验。

## 未完成与历史失败

首轮 `pnpm test:all`：unit848/848；native-0为163/193，12失败、18取消，零跳过。随后用户改变验证范围，native-1、三个compat组及history未执行。不能把新核心结果拼作原全套通过。

原11成员单项在45秒预算下仍超时：候选诊断约72.6秒、路径调整后最近约60秒；main644约13.2秒只作对照，不是整合通过证据。CPU采样73.5秒中42.2秒在重复详情目录探测，说明了本次减少探测的依据，但不能声称已解决原大规模延迟。

新增运行中目录换链演练在Windows打开句柄后rename被EPERM拒绝，未绕过；原预置junction、身份替换、缺失/损坏详情回归保留。真实DSH页面、真实启动延迟和真实库迁移未执行。

历史sessionController报错未复现、根因未定；后续只读调用HTTP200/ok true。此次启动改进不作为修复该历史报错的证据。

## 合成基准及迁移

`node --expose-gc scripts/benchmark-observer-pages.mjs --base 644ff90c694e19f661177ffd7b5e595d452a9fae`

1万条内存消息的HTTP响应17,007,952B变为17,169B（群摘要+10条消息）；5次串行样本中位约152ms变32ms。只用localhost合成夹具，非真实磁盘/浏览器/生产P95。

新代码兼容旧内联记录；外置后schema3使旧二进制拒绝打开。回滚保留原库及匹配原工作区。只提供显式离线副本迁移，不在启动或GET自动迁移；源库与工作区不删除。总磁盘需计入详情容器、派生证据和回滚副本，不等于中央库体积。

完整入口及兼容限制见 `observer-pagination-coverage.md`、`observer-file-pagination.md`；运维说明见 `../ops/task-ledger-details.md`、`../ops/startup-performance.md`。
