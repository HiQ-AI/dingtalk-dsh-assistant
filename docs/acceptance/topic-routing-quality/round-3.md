# 第 3 轮：实现中的综合功能证据与修复复验

日期：2026-11-03

## 结论与版本边界

本轮汇总 D、routing-core 与 routing-recall 在共享实施工作树中的定向测试，按报告原样保留首轮失败和修复后的组合通过；不把重叠测试计数相加，也不宣称全量验收全绿。各成员回报的执行基线为 worktree `worktree-topic-routing-quality`、HEAD `c80d42bf747cb950aa03ab7906194123bfc5683a` 加未提交实施改动。D 给出了其负责文件及同期 fixture 状态，但没有内容 hash；core 明确未捕获执行时 HEAD/diff/hash。事后工作树状态不能反推各命令执行时的精确源码快照，因此以下 `PASS*` 仅表示该命令在成员报告的当时工作树上通过，不等于最终源码绑定验证。

没有执行真实模型、付费评估、真实钉钉发送或部署。脚本模型及 native Host/HTTP mock 结果只证明所测合同，不证明语义准确率或真实服务效果。

## 澄清通知链：失败尝试与修复后组合

首轮组合命令（PowerShell，设置现有隔离 native profile）：

```powershell
$env:DSH_NATIVE_TEST_PROFILE = (Resolve-Path 'test/fixtures/native-profile/package.json').Path
node --test test/topic-routing-clarification-native.test.js test/task-notification-delivery.test.js test/task-notification-retry-native.test.js test/group-notification.test.js test/fixed-topics-native.test.js
```

D 报告 65 项中 64 通过、1 失败。失败为 `test/task-notification-retry-native.test.js:14` 的 lifecycle business 超过 10000ms；澄清用例当时 7 项通过，其余组合文件通过。根因是共享 `test/fixtures/task-session-native-host.js` 的 `topicTaskCalls` 仍提交已退役的 `workflowRefs` / `workflowReason`；A 更新 fixture 以匹配新 route reason/candidateComparisons 合同，未提高超时或删除断言。该失败留在本报告，不用后续结果覆盖。

更新 fixture 后执行的修复复验组合命令：

```powershell
$env:DSH_NATIVE_TEST_PROFILE = (Resolve-Path 'test/fixtures/native-profile/package.json').Path
node --test test/topic-routing-clarification-native.test.js test/task-notification-retry-native.test.js test/notification-pending-source.test.js test/task-notification-readback.test.js
```

D 报告 43/43 通过，总耗时 11455.7032ms，其中原 lifecycle 失败用例在这次组合运行中耗时 1628.8262ms 并通过；它不是单独重跑。澄清测试 12/12。D 说明澄清源码此后未再修改；执行时仍是共享未提交树而非纯 HEAD。

12 项覆盖：无 Topic 的真实通知送达但 hold 不结清、冷恢复不重复提问及回声处理、普通讨论不澄清、未声明问题不发送、DWS 来源静默、消息仅提到助手但实际交同事不发、发送前 resume 竞态、出箱落盘后 prepare 前断点、unknown 只读回读、cc 与 false 元数据、空白点名与 false 元数据、送达后 scope 变更、发送许可前 scope 变更。B 发现并复核点名正则转义/false 元数据否决与通知身份风险，D 在其独占的 `dynamic-task-store.js` / `task-session-service.js` 完成修复；通知身份固定使用持久 `clarification.epoch`，与本地 hold scope 更新的 `hold.epoch` CAS 分离。D 不审查自己负责的通知实现，该部分由 A 独立审查；此项不表示全部代码审查完成。

澄清 native 用例最初有 4 项因默认 profile 缺少 `dsh-base` 在 prepare 阶段失败；改用上述既有隔离 profile 后通过。该环境准备失败不计入功能通过数。此前更早的 65 项结果和后续 43 项组合都保留，不能将运行总数相加为一个通过率。

## Core 定向合同与恢复

routing-core 报告在同一 PowerShell 中依次执行，第二条由第一条 exit code 0 门禁：

```powershell
node --test test/topic-runtime.test.js test/group-decision-contract.test.js
node --test --test-name-pattern="路由审计理由变更" test/topic-store.test.js
```

第一条 187/187，第二条 1/1。路由/决策合同命令包含 round-1 曾有 8 个旧 workflow fixture 失败的 runtime 范围；这次结果属于后续修复态，不抹除 round-1 历史。第二条只验证路由审计理由变更重放，不是 round-2 固定版本摘要断言的复验；round-2 的既有 FAIL 仍未在本轮复测。

Native profile 下的组合命令：

```powershell
$env:DSH_NATIVE_TEST_PROFILE = (Resolve-Path 'test/fixtures/native-profile/package.json').Path
node --test test/topic-routing-clarification-native.test.js test/topic-routing-hold-native.test.js test/task-notification-retry-native.test.js
```

core 报告 14/14、0 skip；按用例归属为 clarification 12、hold 1、retry 1。命令合并执行，三文件没有各自单独运行。此结果与 D 的 43 项组合存在测试重叠，不合并成额外总数。首次未设置 profile 的 native prepare 失败 13、跳过 1，不能记为通过。

core 未记录上述命令执行时的 HEAD/diff/hash。其事后只读回查到 HEAD c80d42bf、15 个 tracked 文件修改（498 新增/86 删除）及 6 个新测试，但明确这些不能绑定测试执行时源码。因此最终冻结源码仍需统一复验。

## Recall 与看板/待判恢复

- Recall 性能：routing-recall 报告 `node --test test/topic-recall-search.test.js` 4/4。覆盖 2000 条目录下空查询/多词查询每次只访问 5 个 `topicId`（分页后投影）、长输入分词不超过 4000 字符且取得 5 个有效词后停止，并保留引用优先/目录预算合同。执行时是 c80d42bf 加 A/B 并行未提交树；不是最终源码绑定，也没有模型准确率结论。
- 看板/API mock：`node --test test/observer-group-pages.test.js test/fixed-topics.test.js test/topic-routing-hold-observer.test.js` 41/41，检查待判展示不被旧完成戳覆盖、CAS信息、索引变化与本地 HTTP mock。隔离 Edge 浏览器脚本 `node docs/acceptance/topic-routing-quality/scripts/verify-routing-hold-browser.mjs <playwright/index.mjs> <react-dom.development.js>` 报 1/1，检查理由展示、默认重判请求版本/epoch、完整范围未确认禁用及确认后的 payload；命令参数来自当时隔离包路径，临时包与截图已清理。HTTP 为 mock，不证明真实服务恢复。
- Native hold 恢复：profile 配置后 `node --test test/topic-routing-hold-native.test.js` 报 1/1、0 skip，覆盖 defer、source 未 routed、旧 epoch 409、非法 scope 400、鉴权 HTTP resume、暂停模型期间 pending 到最终 routed 且 `source.routed=true`，Task/Outbox 均为 0。使用脚本模型，不代表付费模型或真实钉钉。

以上 recall/看板/native hold 证据同样来自成员报告的并行未提交工作树，没有独立记录内容哈希；不可宣称覆盖最终源码。

## 未验证与下一步

- A 的路由首包预算修复与最终审查仍待完成；D 通知块由 A 审查，B 对通知块独立终审未报告其他可证实问题，但这不等于全项目终审完成。
- 新测试文件稳定后，映射单写者再运行 `node scripts/test-suites.mjs update`，审阅完整 `test/suite-map.json` diff 后运行 `node scripts/test-suites.mjs check`；本轮未运行，不改 mixed 分类。
- 最终冻结源码的定向回归、round-2 固定版本摘要既有 FAIL 复验、完整审查边界、真实模型语义质量、部署及真实钉钉结果仍未完成/未验证。此前真实模型从未运行。
- README 已更新稳定的召回、待判与澄清通知合同；评估合同等 C 确认 runner/provider 稳定后再补。

矩阵中带 `*` 的 PASS 是成员当时命令结果，不是最终源代码验收；失败历史不删除、不冲销。
