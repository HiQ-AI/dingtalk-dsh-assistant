# 第 5 轮：冻结源码的定向整合验证

日期：2026-11-03

## 当前结论

核心实现及其相关合同已在冻结的未提交工作树验证；整体验证尚未完成。不得将本轮称为全绿。真实模型质量、真实钉钉、部署及真实角色中执行大候选/元数据分页的端到端未验证。

## 版本绑定

- 工作树：`worktree-topic-routing-quality`，起点 `c80d42bf747cb950aa03ab7906194123bfc5683a`，包含未提交实现与测试改动。
- 核心命令执行前后对 215 个产品源码/相关测试/锁文件逐文件 SHA256；`round-5/core-binding.json` 记录完整清单、时间、Node 版本与命令。前后漂移为 `[]`，不是只用 HEAD 指代源码。
- 精确日志：`round-5/core-tests.tap`。两文件已独立读取并核实真实结果。

## 冻结核心与相关合同

```powershell
node --test --test-concurrency=1 --test-reporter=tap test/topic-runtime.test.js test/group-decision-contract.test.js test/coordination-sessions.test.js test/topic-store.test.js test/topic-recall-search.test.js test/topic-routing-hold-observer.test.js test/observer-group-pages.test.js test/dynamic-task-store.test.js test/notification-pending-source.test.js test/task-notification-readback.test.js
```

实际 454 项：450 pass、1 fail、3 skipped、0 cancelled，41534.1735ms，exit 1。

- 新合同、候选审计/理由、请求身份、JSON 预算/冻结元数据及候选续读、待判持久化与共同恢复、召回性能、HTTP/看板投影、动态通知账等在命令覆盖内；不证明模型语义质量。
- 唯一失败：`固定版本不暴露后来摘要，旧决策完成不关闭已收到新输入的话题`，当前 `test/topic-store.test.js:535` / 断言 `:546`，actual=`第一版`、expected=`''`。与 round-2 的精确基线对照一致；保留失败，不改原断言、不声称已解决。
- 3 个 skip：`notification-pending-source.test.js` 的 sameAuthor=true/false 原生接纳与原生富化用例。该命令未设置 `DSH_NATIVE_TEST_PROFILE`，默认 profile 缺少 `dsh-base`。这些项不计通过，须在最终原生批次用既有隔离 profile 实跑补齐；不重复执行其余已通过核心项。

## 原生整合与评估

首次原生采集器准备使用 `test/fixtures/native-profile/pnpm-lock.yaml`，该文件不存在；profile 属 workspace，实际使用根锁文件。此尝试在读取指纹阶段即退出，未启动测试，不计功能失败或通过。

修正锁文件后用 `DSH_NATIVE_TEST_PROFILE=test/fixtures/native-profile/package.json` 串行执行 9 文件：task-background-retry-native、task-session-human-native、task-session-reply-identity、task-session-service-native、task-topic-routing-native、task-web-topic-reuse-native、topic-routing-clarification-native、topic-routing-hold-native、notification-pending-source。原生命令仍保留各用例原 timeout，采集器本身设 600 秒外层上限。

结果：采集器达到 600 秒，`spawnSync ... ETIMEDOUT`、status=null，没有完整 TAP 结束摘要，不能宣称整个批次已完成。已落盘顶层记录 105 条（101 ok、4 not ok），其余未结论；238 个源码/fixture/测试/锁文件前后漂移为 `[]`，见 `round-5/native-binding.json` / `native-tests.tap`。

已见失败（保留原阈值）：

| 用例 | 位置 | 实际结果 |
| --- | --- | --- |
| 话题历史自身通知不阻断人工补充-native-user | `test/task-session-service-native.test.js:117` 注册包装器 | business 超过 15000ms |
| 话题历史自身通知不阻断人工补充-colleague | 同上 | business 超过 15000ms |
| 话题历史未准入真实消息仍拒绝更新且不发送成功回复-native-user | 同上 | business 超过 15000ms |
| native batch followup reopens each original completed task and session once from one coordination topic | `test/task-topic-routing-native.test.js:288` | business 超过 30000ms |

Lead 随后定向查询这些测试文件对应的 node 进程，结果为空，无需 kill。B 接回上述两个文件的定向排障和原阈值复验，原生运行资源在 B → C 间串行交接。尚未证明四个失败的根因，不增加阈值或移除断言。外层整批采集 deadline 与每例业务 timeout 是两回事；后续采集不以任意 600 秒截断长批次。

已有实施期回执在 round-1 至 round-4 保留，不倒写成最终版本证据。

## 评估零副作用预检

Lead 独立执行实际 provider 配置的 `--check`（不是 offline）：holdout 16 条、issues=[]、exit0、paidCalls=0、liveAuthorized=false。数据 SHA256 `d41bbddbd23979017766a18f1b111e722bbb4109ba40a2eab8983a5669e93cfc`，base/provider 均解析到 `0.2.1-alpha.2`。命令及完整绑定在 `round-5/preflight-check.json`。未读取凭据或验证网络可用性，不等同付费 provider 可用/模型质量通过。

## 测试映射

`node scripts/test-suites.mjs update` → `mapped 341 files; historical 3; deleted 0`；`check` → `verified 341 files; every file exactly once; historical 3; deleted 0`。E 审阅且 Lead 独立结构对照原 335 项：仅新增 6 项，既有字段变化 0、删除 0；均 release=true，mixed/history 分类未改。

## 附件保留说明

本轮报告中的原始中间附件已按保留规则清理，不另行备份或转移归档；原轮次结果及失败不变。最终必要证据集中保留于 `round-7/final-validation.json`：含各批命令、执行时/当前源码SHA、嵌套测试记录与失败细节、原日志SHA、全部104/16评估观测和前后绑定。第7轮两份最终原生TAP仍保留。汇总已独立核对后才清理原附件，不能将新汇总当作重新执行测试。
