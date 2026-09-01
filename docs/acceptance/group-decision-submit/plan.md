# 验收计划

## 症状

同一 turn 后续 Steer 形成新 step 时，turn 最终普通文本覆盖此前合法 Decision；turn 级提取也无法承载多个独立判断。

## 根因

业务结果使用 assistant 文本表达，并以 `turn/end` 作为提交边界，缺少结构化调用身份、请求归属和一次性副作用语义。

## 修复

- 注册 Resident 专属 `group_decision_submit` 工具。
- Steer 携带 pending request ID，模型按 step 提交一个或多个结构化判断。
- Runtime 原子校验请求集合，按最早消息选 owner，共享判断只执行一次。
- pending 等待移出群级串行区，锁只覆盖共享状态提交。
- 删除群 Decision 的文本提取、schema correction 与 turn-finalize 路径。

## 验证

按 `matrix.csv` 逐项执行；每轮结果写入 `round-N.md`，全部通过后生成 `report.md`。
