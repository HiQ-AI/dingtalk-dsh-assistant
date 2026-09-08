# Round 5：最新 main 第二轮可靠性修复

## 基线

- 分支：`feature/resident-runtime-followup`
- 基线：`main@24a8c64ab3ac90917a3a305a669f70026e5d349e`
- 隔离范围：真实 Store、Runtime 与 DSH JSON 快照校验；Agent、模型和 DWS 使用替身。

## 修复前结果

| 用例 | 结果 | 观察 |
| --- | --- | --- |
| R1 | FAIL | `group_topic_route_submit` 与 `group_topic_route_review` 返回值不能形成 lossless JSON。 |
| R2 | FAIL | Task v2 保留 v1 待审 checkpoint；产生两条审阅，恢复写回报 `task_input_version_stale`。 |
| R3 | FAIL | reopen 后 Task 为 running/runSequence 2，但旧 idle 回调 dispose handle，下一 checkpoint 报 `task_leaf_not_active`。 |
| R4 | FAIL | 并发上限 1 时竞态产生 2 个 running Task。 |
| R5 | FAIL | 10 条各 12,000 字符的增量形成约 123,240 字符决策信封。 |

修复后结果、全量测试、打包和简单 E2E 在本轮完成后追加，不覆盖上述失败基线。

## 修复后结果

| 用例 | 结果 | 观察 |
| --- | --- | --- |
| R1 | PASS | Topic 工具注册边界统一做 JSON 投影；归类提交、归属复核和固定 Topic 读取均满足 lossless JSON。 |
| R2 | PASS | 首次提交与 Supervisor 复用同一持久 checkpoint；preserve 输入作废待审项，叶子可按 Task v2 重新提交。 |
| R3 | PASS | 完成轮次的 idle 回调发现 Task 已进入 runSequence 2 后不回收 handle；新轮次 checkpoint 成功。 |
| R4 | PASS | 慢 Session 创建计入容量；人工批准保持 queued，并发上限 1 时 running 数量不超过 1。 |
| R5 | PASS | 10 条各 12,000 字符消息的内联数组不超过 40,000 字符；缺失增量未读时拒绝，分页读完后接受。 |

## 回归与产物

- `node --test test/topic-runtime.test.js test/runtime.test.js`：94/94 PASS。
- `pnpm test`：248/248 PASS。
- `node docs/acceptance/resident-topic-leaf-audit/scripts/probe.mjs`：A01–A10 10/10 PASS。
- `node scripts/build-web-client.mjs` 后 Web Client 无内容差异。
- `git diff --check`：PASS。
- 根包、assistant 子包、observer 子包共生成 3 个 tgz，分别为 20,063、96,388、18,064 字节。

本轮隔离 E2E 使用真实 Store、Runtime、DSH JSON 输出规则和 Agent 生命周期替身，不连接真实模型与 DWS。合并后的本机 profile 部署和运行态检查单独记录。
