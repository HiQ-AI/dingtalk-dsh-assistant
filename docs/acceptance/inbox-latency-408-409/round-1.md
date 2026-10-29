# Round 1 — 基线与并行实现验证

日期：2026-10-29（Asia/Shanghai）

## 范围与约束

- 隔离工作树：`worktree-inbox-latency-408-409`，基线起点 `9dd585f0`。测试结果需按其真实运行代码状态区分：原始基线、并行实现 diff、独立受控实验；均不等价于现场验收。
- 未访问正式数据库、未重放 #408/#409 消息、未发送钉钉通知。
- `dynamic-task-store.js:132-137` 的既有合同是 `task.get` 按 ID 回查 archive table，`task.list` 默认只列 active。待解决缺口应描述为 active 缓存和 coordinator 按 ID 上下文，不应写成底层 `task.get` 不支持归档或引入 `includeArchived` 参数。

## 结果

| 验证项 | 结果 | 命令/证据 | 解释与边界 |
|---|---|---|---|
| Owner 接纳受控交错 | PASS（复现基线问题） | `node docs/acceptance/inbox-latency-408-409/scripts/owner-admission-race.mjs`；完整实验记录见 `round-1-owner-admission.md` | Lead 在配置原生 profile 后独立执行，stdout：`{"result":"REPRODUCED","lease":2,"ownerRuns":2,"cancelObservedRun":2,"admissionSettledWhileNewOwnerBlocked":false}`，exit 0。证明受控交错中接纳等待新启动的 Owner；`run`/`cancel` 是桩，不证明真实 Agent 被取消，也不证明现场 148 秒全部由此导致。 |
| 旧合同定向回归 | PASS | `node --test test/task-archive-scheduling.test.js test/coordination-resources.test.js test/performance.test.js`；50 tests，50 PASS，0 FAIL/skip，23,336.55 ms | `9dd585f0` 基线。仅为旧合同基线，不是本轮修复验证。 |
| 原生 topic routing 基线 | PASS | 设置 `DSH_NATIVE_TEST_PROFILE=D:/dsh_home/profiles/web/package.json` 后运行 `node --test test/task-topic-routing-native.test.js`；13 tests，13 PASS，0 FAIL/skip，33,248.18 ms | host 使用 `mkdtemp`，fixture 持久化在 root，通知为 stub。此前未配置 profile 的独立运行是 2 PASS、11 SKIP（缺 `@deepseek-ai/dsh-base`），不计为原生通过；补跑后已通过。 |
| Web replan drains 基线单项 | PASS | 设置 native profile 后运行 `node --test --test-name-pattern='Web replan drains' test/task-topic-routing-native.test.js`；1 PASS，0 FAIL/skip，10,887.36 ms | `9dd585f0` 基线。该测试未复现根因，也未证明修复后新代不会被取消。 |
| topic-runtime 合同测试 | PASS | 并行源码/测试 diff 下运行 `node --test test/topic-runtime.test.js`；143 tests，143 PASS，0 FAIL/skip，7,402.94 ms | 覆盖跨群、错配、分事项授权等合同；不是原始基线或现场验收。 |
| UTF-16 多事项遗漏范围 | PASS | 并行实现 diff 下运行 `node --test --test-name-pattern='遗漏范围按 UTF-16' test/topic-runtime.test.js`；1 PASS，0 FAIL/skip，409.20 ms | 断言 emoji 的 UTF-16 范围 `[2,4)`、两事项分别 `[5,9)`/`[10,14)`，且不创建 Topic。 |
| 不存在任务错误分类 | PASS | 并行实现 diff 下对应单项运行；1 PASS，765.18 ms | 断言返回 `task_not_found` 且不返回 `wrong_group`。具体命令未随结果提供，需在最终稳定 diff 上补证。 |
| 独立 ground-truth 合同抽验 | PASS | Lead 报告：`node --test --test-name-pattern='遗漏范围按 UTF-16|决策一次报告独立动作|关联Task上下文有界且不截断正文|Topic 关联不能替代原消息授权' .claude/worktrees/inbox-latency-408-409/test/topic-runtime.test.js`；4 tests，4 PASS，0 FAIL/skip，953.6322 ms | 并行 diff 下的独立抽验，覆盖缺失 task 互斥错误、emoji 多事项遗漏、跨群上下文、来源授权；不是原始基线或现场验收。 |
| 历史单项回归 | PASS | 测试方报告单项 1 PASS，1,153.35 ms | 结果转述未附命令/测试名，保留为待补命令的辅助证据，不用于扩大验收结论。 |

## 尚未通过/未验证

- Owner admission 修复、慢旧 Owner 排空、慢新 Owner 阻塞、重启恢复：尚无稳定修复 diff 的完整回归证据。
- 归档/真正跨群/不存在的差异化行为：部分错误分类单项已测；完整对照组合待稳定 diff 回归。
- 基线复现不等于修复验收；所有并行 diff 测试须在稳定实现后重新运行与记录。
- 未做生产数据库、真实钉钉消息、真实 Agent 取消、现场 #408/#409 复跑或耗时归因验证。
- 未写 `report.md`：当前尚未全绿。
