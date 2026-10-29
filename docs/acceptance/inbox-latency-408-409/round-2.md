# Round 2 — 首版修复与回归证据

日期：2026-10-29（Asia/Shanghai）

## 范围

- 使用隔离 worktree `worktree-inbox-latency-408-409` 上首版并行源码 diff；测试输出按各自命令和运行状态保留，不等同于稳定 diff 或现场验收。
- 不访问生产数据库、不重放 #408/#409、不发送钉钉消息。平台实验使用临时 SQLite/native host 与受控 Owner 桩，记录见 `round-1-owner-admission.md`（该文件由 platform 独占维护，本轮未修改）。

## 首版验证与问题

| 项目 | 结果 | 证据 | 限制/后续 |
|---|---|---|---|
| Web replan 的新 Owner 接纳门闩 | 初次运行失败：超时 | 测试方报告：`node --test --test-name-pattern='Web replan blocks a new Owner' test/task-topic-routing-native.test.js` 在 30 秒 timeout 后 exit 1，1 cancelled | 当时等待栈未单独定位，不能断言是业务死锁或归因到具体等待点。 |
| Owner cancel-failure 恢复路径 | FAIL（前两次独立运行）/ PASS（合同诊断后） | 指定 profile，同名测试 `failed old-drain ends its timing`：初次 1 FAIL、4,566.7294 ms，测试按 code 匹配但实际错误 message 为 `fixture cancel failed`；修正 matcher 后第二次仍 1 FAIL、3,161.9385 ms，阶段结束断言通过但 recover/whenIdle 后新 replan 为 `TASK_TOPIC_WEB_topic-busy`。诊断后第三次 1 FAIL、3,260.4105 ms，确认原 decision failed、operation applied/reconciled、nextRetryAt 在未来，因此未到期请求按合同返回 topic-busy。随后测试将 fixture 的 nextRetryAt 设为过去再 recover，同任务 replan 成功，host/old-drain 落终止；最终同名命令 1 PASS、0 FAIL/skip，4,450.4804 ms。 | 合同诊断版通过的是“未来 retry 时间保持 busy；到期后恢复可继续”的用例，不是活旧 Owner 排空失败。该例旧 Owner 已排空，不代表活旧会话排空失败或真实等待时长。前两次失败历史保留；不据此证明所有 cancel-failure/replan 场景。 |
| 材料失败恢复正式测试 | PASS（专项，修复后） | 指定 native profile 后：`node --test --test-name-pattern='Web material failure recovers once' test/task-topic-routing-native.test.js`；最终收紧断言复跑 1 PASS、0 FAIL/skip，2,080.5995 ms。较早版本 1 PASS、6,269.1993 ms；增加失败阶段真实结束检查后 1 PASS、0 FAIL/skip，4,934.0187 ms | 真实 SQLite/service，Owner 为桩。覆盖材料失败必须为 `TASK_MATERIAL_PATH_INVALID`、优雅关闭重开恢复 snapshot、同请求不同键序成功、异值 `DYNAMIC_COMMAND_ID_CONFLICT`，且 revision/Owner 不重复。未模拟突然崩溃、旧指纹或真实外部效果；各次运行独立保留。 |
| 材料失败/重放加强断言 | PASS（专项） | 指定 profile 后 `node --test --test-name-pattern='Web material failure recovers once' test/task-topic-routing-native.test.js`；1 PASS、0 FAIL/skip，2,782.2265 ms | 校验未完成记录保留原始 JSON 顺序 fingerprint，action 键序反转得到不同 fingerprint；优雅重启先重试未完成记录再显式 recover；同值不同键序成功，异值拒绝且 Owner/revision 不重复。未注入其他历史版本数据库、未模拟突然崩溃或真实外部效果。 |
| Platform execution claim 双门闩 | PASS（专项） | 指定 native profile 后：`node --test --test-name-pattern='replan fences an execution claim' test/task-topic-routing-native.test.js`；2 PASS、0 FAIL/skip，3,484.5908 ms | 真实 SQLite/service，Owner/Execution 为桩：提交前 claim 被拒且不运行执行；提交后响应挂起至门闩释放，执行桩回读 `execution.current=false`。不证明真实 Agent fencing 或现场行为。 |
| Host 三阶段计时合同 | PASS（专项） | 指定 profile 后 `node --test --test-name-pattern='Web replan blocks a new Owner' test/task-topic-routing-native.test.js`：真实 startedAt/completedAt、包含关系与顺序断言 1 PASS、3,632.5371 ms；随后增加 old-drain gate 保持打开及非法 phase 拒绝断言，1 PASS、2,889.5133 ms | 仅验证指定 Host 子阶段 `task-commit`/`old-drain`/`materialize` 的顺序、边界和非法值拒绝；嵌套 Host 总耗时不相加。失败阶段结束行为由其他单项覆盖；不证明任何现场性能归因。 |
| 原生任务 topic routing 当前集成回归 | PASS（并行未提交 diff） | 指定 `DSH_NATIVE_TEST_PROFILE` 后运行 `node --test test/task-topic-routing-native.test.js`；19 tests，19 PASS，0 FAIL/cancelled/skip，47,451.4381 ms；其中既有 `Web replan drains the old Owner without waiting for the new Owner` 双 gate 用例也通过 | 该用例断言旧 gate 关闭时不 accept，释放旧 gate 且新 Owner gate 仍关闭时接纳；同一用例在基线也曾通过。只证明该双 gate 合同，不证明最初 `execution.list` 竞态已修复，也不证明真实 Agent 取消或完整 timing。整合回归覆盖归档参数、Owner/Execution claim gate、材料恢复及 host 阶段/门闩；测试方说明源码/test diff 尚未提交，非现场验收。 |
| Web replan 门闩重跑 | PASS（测试桩变更后） | 测试方报告在桩改为 `submit(wait)+submitted` 后运行同一 pattern：1 PASS、0 FAIL/skip、约 7.00 秒；lead 使用同一 native profile 独立复跑：1 PASS、0 FAIL/skip、4,040.6975 ms | 断言 hold 门闩期间未新启/未 accept（runs=1），门闩释放后在新 Owner 仍阻塞时接纳，取消时 runs=1。测试桩变更后旧的已返回 cancelled 合同不再适用。初次 timeout 的栈未定位；结果仅证明该测试桩场景，不外推至真实线上时序。 |
| 并行编辑期间测试启动错误 | PENDING（仅记录事件，非产品失败） | Lead 指示保留一次并行编辑 `SyntaxError` 事实；当前未取得原始命令、错误文本、exit code 或修正后的对应补跑证据 | 原始工具/命令错误与后续测试结果需分开记录。未取得完整凭据前，不据此记测试 FAIL，也不以其他用例通过抵销。 |
| topic-runtime 定向合同抽验 | PASS | 见 `round-1.md` 中 Lead 独立四用例抽验：4 PASS、0 FAIL/skip，953.6322 ms；并行 diff 下 topic-runtime 全文件 143 PASS | 属于首版并行 diff，非原始基线、稳定最终 diff 或现场验收。 |
| UTF-16 多事项遗漏范围 | PASS | 见 `round-1.md`：emoji `[2,4)`、两事项 `[5,9)`/`[10,14)`，不创建 Topic；1 PASS | 范围是该 targeted fixture；需在稳定 diff 重跑。 |
| 原生归档上下文与参数校验 | PASS（专项） | 配置 `DSH_NATIVE_TEST_PROFILE` 后运行 `node --test --test-name-pattern='native task context reports invalid arguments' test/task-topic-routing-native.test.js`；1 PASS、0 FAIL/skip，5,419.1966 ms | 测试方报告覆盖 8 种非法参数、同群/跨群冷归档及不存在任务，断言错误分别为 wrong_group/not_found 且不泄露跨群机密。按当前隔离工作树并行修复 diff 记录；非稳定最终全量回归或现场验收。此前同名测试结果分别保留，不覆盖。 |
| 不存在任务错误分类 | PASS | 见 `round-1.md`：单项 1 PASS，要求 `task_not_found` 且不为 `wrong_group` | 测试方未附单项命令，须在最终回归补齐精确命令。 |
| 独立 topic-runtime 合同抽验 | PASS | 见 `round-1.md` 中 Lead 独立四用例抽验：4 PASS、0 FAIL/skip，953.6322 ms；并行 diff 下 topic-runtime 全文件 143 PASS | 属于首版并行 diff，非原始基线、稳定最终 diff 或现场验收。 |

## 受控平台实验补充

- 材料路径硬错误：在 `task.revise` 账本提交后、调用返回前，将 source snapshot 目标路径改为目录；输出 `MATERIAL_FAILURE / TASK_MATERIAL_PATH_INVALID / revision=2 / ownerRuns=1`，exit 0。需求版本已经提交，但新回合未运行。
- 优雅重启恢复：同一临时数据重启并 recover 后输出 `RECOVERED`，Owner 总运行数 2，source snapshot 存在且 taskId 正确。
- 幂等重试首版：同一 requestId 与显式参数返回 `web_task_request_identity_conflict`；对比显示 action/topicRefs 内容相同但键序不同。该事实涉及当前格式写出的未完成记录，不是旧格式 writer fixture 或旧数据库兼容证明。修复后实验先有一次脚本断言失败（旧断言要求两次 `submitWebTaskInput`，exit 1）；调整为期望成功幂等重放且仅提交一次后复跑通过，stdout 依次为 `MATERIAL_FAILURE`（`TASK_MATERIAL_PATH_INVALID`，revision=2、ownerRuns=1）、`RECOVERED`（ownerRuns=2、source snapshot 可回读）、`REPLAY`（error=null、revision=2、ownerRuns=2、submissions=1），exit 0。
- 修复后的重试成功且没有新增版本或 Owner，仍仅证明材料故障解除后的优雅重启；不覆盖即时崩溃或现场业务。两次实验事实与修订原因见 platform 独占的 `round-1-owner-admission.md`，本轮未编辑该文件。

## 当前合同文档同步

- `README.md` 已补充：同群归档任务的有限上下文身份与 `allowedActions: []`、跨群拒绝、无效参数结构化问题、底层 `task.get` 按 ID 可回查归档而默认目录不列归档；Topic 原文遗漏范围返回 `issues[].uncoveredRanges`（UTF-16 左闭右开）；Host 子阶段 `task-commit`、非 supplement 的 `old-drain`、`materialize` 及嵌套时不重复相加。
- `docs/ops/task-archive.md` 已同步 `task.get`/`task.list` 与群上下文工具的归档边界。以上为当前代码合同说明，不代表这些合同已由最终稳定回归全覆盖。

## 历史时点的未决项与后续收敛

以下是 Round 2 形成时的状态快照，后续结果记在 Round 3–6，不应当作当前未完成清单：

- Owner admission 初次 30 秒 timeout 与 old-drain/cancel-failure 两次失败均保留；门闩、cancel-failure/backoff 后续合同分别在 round-2 和 round-6 得到定向通过，不能据此外推真实 Agent 或现场耗时归因。
- Topic 归档上下文、跨群/不存在区分及参数 issues 后续原生专项通过，证据见本轮表格及 round-6；不限于初次实现检查。
- Host 子阶段开始/完成、包含顺序及非法 phase 后续专项通过；重启后所有历史 span 完整性、生产计时准确性不在本地测试可证明范围内。
- 并行编辑 SyntaxError 作为历史测试启动事件保留；不属于产品行为验收项，矩阵记为 `NOT_APPLICABLE`，不阻塞交付。
- 生产数据库、真实钉钉通知与 #408/#409 消息重放未执行，明确标为 `OUT_OF_SCOPE`；未创建 report 的早期说明已由最终 report 取代。