# 第 8 轮：原生提及与对外正文

本轮处理用户在第 7 轮之后提出的缺少 `@` 和通知暴露内部标识问题。第 7 轮送达成功不能作为原生提及成功证据。

## 范围

- 普通群提醒、引用回复与 outbox 透传可信 openDingTalkId；非法提及列表发送前拒绝。
- 协调安排、订正、暂停/取消、查询及异常摘要改为业务表达，不输出协调/计划/执行/收件人 ID 或零项技术统计。
- 人工申请去除正文申请号，内部关联保留；任务和话题实际对外字段在接纳前校验。内部 evidence、历史冻结通知和审计字段保留。
- 送达回读不把 userId 当作原生 openDingTalkId 证明。无提及元数据时明确待客户端验证。

## 验证记录

代码实现已完成。环境为 Windows / Node 24，原生测试显式设置 `DSH_NATIVE_TEST_PROFILE=test/fixtures/native-profile/package.json`。

| 验证 | 实际结果 |
|---|---|
| `node --test test/dws-adapter.test.js test/task-notification-readback.test.js test/dws-file-adapter.test.js` | 57/57 PASS，0 跳过，0.761 秒 |
| summary / independent recovery / changes / schedule-revisions / changes-native / final-native 六文件 | 121/121 PASS，0 跳过，35.80 秒 |
| 最后恢复取消边界补充后 `node --test test/coordination-summary.test.js` | 23/23 PASS，0 跳过，0.556 秒；上述集合子集 |
| human-native / topic-routing-native / reply-identity / dialogue 四文件 | 26/26 PASS，0 跳过，73.644 秒 |
| 最后改用 owner 已读来源、避免历史全表扫描后的定向复验 | 8/8 PASS，0 跳过，18.453 秒；上述集合子集 |
| pending-source / notification-delivery / operator-scan / source-replay-native 四文件串行 | 58/58 PASS，0 跳过，12.626 秒；`notification-regression.log` |
| 测试分组映射与差异检查 | 303 文件各一次、历史 3、删除 0；`git diff --check` 通过 |

交叉审查补齐恢复时混用新旧版本、改期被旧实例遮蔽、暂停投影、无通知义务误报等待发送、取消后已有送达/未知边界。未暂停实例不新增快照字段，避免无业务变化触发历史摘要重发。实际运行格式与已知身份双重校验；外部业务 URL 中的同形编号不误伤，但已知内部 ID 即使放在 URL 中也拒绝。

### 发布检查中的超时与复验

默认并发 `pnpm test:release-smoke` 13 项通过、1 项在 30 秒时限取消（`release-smoke.log`）。未改超时、未跳过用例。独立重跑 `test/task-session-package-native.test.js` 2/2 PASS，实际打包任务 14.017 秒、resident 7.571 秒，总 22.179 秒（`package-native-retry.log`）。这证明当前源码真实包能完成任务，原超时具体阶段未被记录；资源竞争是候选解释，不能作为确定根因。

同组串行 `node --test --test-concurrency=1 test/release-workflow.test.js test/release-artifacts.test.js test/task-session-package-native.test.js` 最终 14/14 PASS、0 失败/取消/跳过，总 46.960 秒；实际任务 21.267 秒、resident 6.983 秒。证据 `release-smoke-serial.log`，原超时仍保留。

真实群原生提及仍待验证；测试和部署健康不替代该证据。

最终状态：真实 C 验收未通过原生提及发送。用户 17:50:48/17:50:53 两条输入正确合并，旧澄清未发送；17:51:29 回复 17:57 提醒，约 36 秒可见、38.767 秒核验。用户 17:52:01 再说“提前三分钟”，17:52:42 正确改原计划为 17:54，约 41 秒可见，文案简洁且无内部标识。

17:54 的提醒在 17:54:20.812 接纳、17:54:23.366 准备，随后 CLI 以缺原生提及占位符拒绝（exit 3、validation），没有发送回执。新包只验证参数透传，遗漏 CLI 的内容约束；这是本轮实现/验收缺口，不能归因于网络。另真实恢复暴露不存在的 schedule.get 查询以及已送达后旧快照多余回读的告警。现场记录 `live-c-4.json`、`c-due-notification.json`、`due-recovery-issues.json`，后续改用已有原生引用链路，见第 9 轮。

### 受控部署

已将候选提交 `0c1b5d10463057f424f0e721a5deacb19f001119` 部署到本机；PR #255 仍为 OPEN。先零写入、零信号 Check，确认 59 个原生会话已排空、未知操作/通知为 0，再原生退出和双包安装。Assistant 包 SHA256 `8628a0f644ed9098d723ae7db1abaabb8207c3fa560bb61c4193d4e1331459ac`，Observer `88a51be3b4d532da19740620512daa26c7c36e377a550563ba660aca06a61396`；均为 2.1.0。

17:50:20 独立回读：旧进程退出，新 PID 44488 同时持有 3080/18998，两包摘要一致，profile 不变，health=ok、recoveryIssueCount=0、DWS healthy、入站启用、匿名 Web=401。证据 `packages.json`、`deployment/`、`independent-deployment-readback.json`。A/B 历史通知数量、正文、状态、发送次数和送达时间均与部署前一致，未因新文案重发，见 `history-no-resend.json`。

### 原失败记录只读重排版

从当前数据库以 `readOnly + query_only` 读取原失败安排的权威聚合快照，调用新 formatter，正文为：“原定于2026年10月23日 16:22（北京时间）的提醒通知发送失败，送达情况需要核查。提醒内容：请查看提醒订正验收结果（部署验收1023A）。” 已知协调、计划、实例、收件人身份校验通过；业务写入与外发均为 0。证据 `old-failure-new-format.json`，这是同一事实的本地展示验证，不冒充重新发送成功。

原始命令输出和消息采样保存在本机 `round-8/`，真实人员/群/消息身份不提交到仓库。
