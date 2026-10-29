# Round 4 — 同任务修订与独立任务并行

日期：2026-10-29（Asia/Shanghai）

## 初期探索（已由合同收紧取代，保留历史）

- 测试方报告指定 native profile 下运行 `node --test --test-name-pattern='same-task revisions serialize' test/task-topic-routing-native.test.js`，初版 1 PASS、8,905.6131 ms；诊断版 1 PASS、5,114.7759 ms。
- 实验中，同一任务第二个修订请求在第一个请求的 gate 内返回 `TASK_TOPIC_WEB_topic-busy`；不同任务能在首任务门闩内完成；释放后首任务两版本各增加 1。
- 因同任务并发接纳未发生，初期 PASS 不证明“同任务 revisions serialize”。此处历史待办已由下方收紧后的“同 Topic 修订互斥、异任务独立”合同测试解除；不声称同任务请求排队后都成功接纳。


## 合同收紧后的同 Topic 互斥回归

- 测试方后续报告：指定 native profile 执行 `node --test --test-name-pattern='concurrent same-topic revision is busy' test/task-topic-routing-native.test.js`，1 PASS、0 FAIL/cancelled/skip，6,377.8288 ms；更早的 4,251.4411 ms 版本保留。
- 加强断言：首任务门闩内仅有一轮 Owner；同 Topic 第二请求以 busy 拒绝且不新增 Owner 轮次；其他任务可在门闩期间推进；最终每个任务各两轮。
- 此结果验证的是“同 Topic 修订互斥、异任务独立”，并非同任务请求排队后都成功接纳。运行代码的精确 SHA/完整 stdout 尚未随报告提供，结果按测试方对指定 profile 命令的回报记录；只覆盖受控 SQLite/service 场景，不外推真实 Agent 或现场。


- 该实验结果不证明真实 Agent 并发行为、现场消息或业务效果。
