# 第 16 轮：自身通知迟回读修复与冻结版本验证（阶段记录）

日期：2026-11-05

## 结论与范围

冻结源码提交为 `9c2e623e0ffb3f69d5d33ffbb33b34cf05560755`。本轮聚焦自身通知迟回读后的来源收束、相关固定话题 Native、四文件定向回归及实际包 smoke。A/C 报告的测试与 D 的静态审查已收口；覆盖面仍有明确限制，固定摘要历史失败保留，不能称全绿或完整端到端验收。

本轮测试未触发 CI 或发送真实钉钉测试消息。正式双包更新已完成；随后业务阶段以 BLOCKED 收口。D 于 `2026-11-05T05:18:52.136Z` 逐条核验原固定14条：14/14 当前仍为 processing，canonical source completed=0，pending=true，覆盖当前版本的 completed 决策为0。序号/版本及结果见“业务处理阶段终态”；8条依赖已路由、自身来源退役或通知送达均不计入原14条完成。

## 冻结版本与测试结果

当前工作树中五个关键产品文件的 Git blob 已独立核对，与 A 报告的冻结版本一致：`task-session-service.js` `ceaff17b02a7b5014db7cbd80e302b364383358b`、`dynamic-task-store.js` `c4d20342ee62c8fe9cb7449918d62c5f7d95b152`、`store.js` `0f2995dbeeca45ad71c525801571dd33538995ff`、`native-dws-send.js` `78eff0223f778a7271045a35b544ef8adebd9676`、`topic-runtime.js` `9299ec6fe4b33128de7ac24b4a2b69e834872305`。A/C/Lead 的测试运行于未提交工作树；上述产品 blob 随后绑定到提交 `9c2e623e0ffb3f69d5d33ffbb33b34cf05560755` 和 merge `38f061956fcd73d8c5379fdfa6ae1367da914106`。这表示测试内容与提交的 blob 一致，不表示提交后重新运行。

- A 定向四文件命令 `node --test test/native-dws-send.test.js test/coordination-resources.test.js test/dynamic-task-store.test.js test/topic-store.test.js`：261 项中 260 通过、1 失败、0 skip。唯一失败为固定版本摘要断言，实际为“第一版”、预期为空。精确隔离的 `36ea622ef2b34f2db7ba4fbb81ae36955199ee99` 基线归档副本用原测试和原断言复现同一失败；基线副本已清理。因此该失败是既有基线失败，不归因于本轮冻结变更，也未改写为通过。
- 初始 fixed-topics/native 组合回报为 30 通过、12 因缺少 resident profile / `@deepseek-ai/dsh-base` 跳过。Lead 随后在原生环境完成独立 fixed-topics-native 复验，12/12 通过、0 fail/skip；不把两个运行合并成一次 42/42。
- `pnpm test:release-smoke` 的 GNU tar 环境首轮为 9 通过、3 路径兼容失败、2 因缺少同一 profile 跳过。Lead 原生环境复验为 12/14 通过、0 skip；两个实际包用例超过原 30 秒时限，分别停在 staged/npm pack 与 bytes/dependencies 验证阶段，cleanup 正常。之后按原断言和30秒时限使用冻结包定向复验这两项，2/2 通过、0 fail/skip；business 25924ms、cleanup 626ms，Resident health 7320ms。首轮12/14失败保留，定向补验不写作一次完整14/14。
- C 的自身通知迟回读 Native 集成用例 1/1 通过、0 fail/skip；business 1428ms、cleanup 22ms。用例验证迟到的精确自身回复可收束已入账来源，独立人工消息仍可继续处理。该结果只覆盖此用例；Resident 先知与 Dynamic 未知窗口仅有分层单测和静态接线审阅，未完成完整 E2E。
- D 报告本轮冻结变更审查无剩余高置信 finding。该审查结论不扩大到未实跑的独立窗口或生产业务路径。

## 最终证据

下列 TAP 已逐份读取并核对 SHA256，保留在本轮目录；它们支持各自运行，不覆盖首轮失败或扩大验收范围。 `.gitattributes` 仅对本轮TAP禁用换行归一化，保留Windows原始字节，使仓库blob与下列摘要一致；不修改测试输出或重跑结果。

- `round-16/release-smoke-native.tap`：SHA256 `d9e266878a3d321621c3db45b65076e5fe9edbbaf11bc2761878712beb591e05`；原生环境 12/14 的首轮结果。
- `round-16/fixed-topics-native.tap`：SHA256 `914868897a0cfbd25e533cf55a714c7d4f4f0a5ccaf8c3a020ca5c2834d9886b`；fixed-topics-native 12/12。
- `round-16/package-native-prepacked.tap`：SHA256 `f3627c12c30a96bc0b123e7d893b22ec721bb8a53c4f316de78f6017de87bc4f`；两个实际包用例按原断言定向复验 2/2。
- `round-16/own-late-readback-native.tap`：SHA256 `ad000d3920e8cdaa7384d5b8b10d5fe6386f8587dadc80b318a22618c08f0710`；自身通知迟回读 1/1。

A 四文件定向回归及干净基线复现的输出由执行会话保留；本报告记录命令、计数、失败断言及冻结 blob，不引入其临时宿主日志或原始会话转录。

## 业务处理与交付边界

### 业务处理阶段终态（BLOCKED）

D 于 `2026-11-05T05:18:52.136Z` 对原固定14条逐项核验：当前消息版本均与目标版本匹配，状态仍为 processing；canonical source 均唯一，但未完成；pending=true，覆盖当前版本的 completed 决策为0。下表只列脱敏序号与版本，不含消息 ID、身份或原文。

| 序号/版本 | 当前阶段 | 本轮动作 | 核验结果 |
| --- | --- | --- | --- |
| 788/v1 | processing | 只读核验，未改账 | source completed=0；pending=true；当前版 completed 决策覆盖=0 |
| 789/v1 | processing | 只读核验，未改账 | source completed=0；pending=true；当前版 completed 决策覆盖=0 |
| 790/v2 | processing | 只读核验，未改账 | source completed=0；pending=true；当前版 completed 决策覆盖=0 |
| 817/v1 | processing | 只读核验，未改账 | source completed=0；pending=true；当前版 completed 决策覆盖=0 |
| 818/v1 | processing | 只读核验，未改账 | source completed=0；pending=true；当前版 completed 决策覆盖=0 |
| 819/v1 | processing | 只读核验，未改账 | source completed=0；pending=true；当前版 completed 决策覆盖=0 |
| 820/v1 | processing | 只读核验，未改账 | source completed=0；pending=true；当前版 completed 决策覆盖=0 |
| 824/v1 | processing | 只读核验，未改账 | source completed=0；pending=true；当前版 completed 决策覆盖=0 |
| 825/v1 | processing | 只读核验，未改账 | source completed=0；pending=true；当前版 completed 决策覆盖=0 |
| 826/v1 | processing | 只读核验，未改账 | source completed=0；pending=true；当前版 completed 决策覆盖=0 |
| 829/v1 | processing | 只读核验，未改账 | source completed=0；pending=true；当前版 completed 决策覆盖=0 |
| 830/v2 | processing | 只读核验，未改账 | source completed=0；pending=true；当前版 completed 决策覆盖=0 |
| 831/v2 | processing | 只读核验，未改账 | source completed=0；pending=true；当前版 completed 决策覆盖=0 |
| 832/v1 | processing | 只读核验，未改账 | source completed=0；pending=true；当前版 completed 决策覆盖=0 |

D 另核 T1 revision/processed/completedMax 为 56/49/49，T2 为 19/4/4。原34条首轮恢复与当前9项CAS恢复分开统计；当前9项依赖中8条已 routed，唯一非 own 屏障仍为序号842/v1/e2 的 needs-context hold，无 scope、无正式 clarification。缺少具体分享内容及所指事项，不能代选。D 于 `2026-11-05T05:22:30.274Z` 定点核对该 hold 无 clarification draft、无引用，未满足正式澄清准备条件；关联 outbox 与 Dynamic 活动/归档直接来源通知均为0，因此没有已发送澄清，也不是在等待已发问题的答复。外部最小缺口是具体分享内容及所指事项，或明确说明该消息不是交给助手；如涉及其他群，再补目标群，不要求重复确认已知当前群。当前实现允许真实钉钉新消息引用待判项后清除 hold、补入上下文并正常路由（`packages/dingtalk-dsh-assistant/store.js:843`）；不能代填 scope 或继续盲目 resume。两项 Host 资源读取经核 owner 绑定有效，各取回1张图且 `isError=false`；一项路由有回执并结束 turn。各 sourceRefs 均未匹配 Task（Task=0），直接来源通知为0；这不证明所有间接通知均不存在。

关于自身通知：D 核实一条来源按合同在两账中合法退役并清除对应 hold；另两条已完成且无阻塞，按合同未标记退役，不能说三条都已退役。三条通知均 delivered、`sendAttemptCount=1`，无新增发送尝试。这些依赖和自身来源结果均不计入原14条完成。业务阶段结论为 BLOCKED，原14条完成数为0。

## 合并与部署

PR #343 已于 `2026-11-05T04:55:21Z` 合并，merge commit 为 `38f061956fcd73d8c5379fdfa6ae1367da914106`；我通过 `gh pr view 343 --json url,state,mergedAt,mergeCommit` 独立核对了状态。

Lead 正式双包更新任务 `bxm4xhh3a` 已完成并 exit 0。根据 C 的回报，Lead 已读取阶段回执并独立核现场：旧 PID 60180 经 SIGINT 退出、剩余后代0；新 PID 10052 于 `2026-11-05T12:59:22.583352+08:00` 创建，`2026-11-05T05:03:01.8346666Z` 回读时双端口同属新 PID、旧进程不存在。GET health 为 ok，inbound/bridge healthy，recoveryIssueCount 0；两 listener ready、两 backfill 成功。安装双包均为2.3.0，95/4项安装校验通过；Assistant SHA 前缀 `fd7debd7`、Observer SHA 前缀 `84e11494` 与已核包一致。profile patch 前缀 `1f2c3b27` 未变，自启 true，未建备份。保留 `ownerReleased=false`、`staleOwner=true` 及 `unknownOperations=3`、`unknownNotifications=0`，未伪造清理或完成。

D 于 `2026-11-05T05:05:01.873Z` 完成独立部署核验：95/4 项归档、源码与安装文件一致，规范 blob 对 merge commit `38f061956fcd73d8c5379fdfa6ae1367da914106` 逐项 mismatch=0；实时健康正常、双端口属于 PID 10052、旧 PID 60180 不存在，profile 摘要与自启状态一致。D 的部署核验不等于原14条业务完成。

本轮未重做 round-15 固定20条的部署后对照，不更新其历史结论。原固定14条以05:18:52.136Z逐条只读终态为准；部署健康、依赖路由、通知送达和自身来源退役均不替代其业务完成。

未运行完整冻结回归或完整映射分组；release-smoke 中已实跑测试映射守恒检查，不能代表完整分组验证。未发送真实钉钉测试消息，原14条尚未取得恢复完成终态。相关测试在未提交工作树运行，后按相同产品 blob 绑定至 `9c2e623e0ffb3f69d5d33ffbb33b34cf05560755` / `38f061956fcd73d8c5379fdfa6ae1367da914106`，未在提交后重跑。
