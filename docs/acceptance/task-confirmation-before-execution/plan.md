# 验收计划

## 需求

群消息触发任务创建、续接、重开、提议或取消时必须有群回复；除快速取消信号外，叶子处理必须在确认可靠提交后开始。

## 改动

1. `group_decision_submit` 对 Task 动作空回复返回结构化 `reply-required`。
2. 提交阶段先写回复 Outbox，再执行 Task 动作并回填 Outbox 的实际 Task ID。
3. 快速取消信号继续在 Task 串行队列和回复投递前触发。
4. 更新 Resident 协议、README、运维说明与回归测试。

## 验证

- 空回复零副作用及同请求可重试。
- Outbox listener 中尚无新 Task/重开/上下文推进，提交后才出现动作结果。
- stale、回复审阅、附件缺失和快速取消既有用例。
- 全量测试、打包、安装哈希、本地服务和原 Resident Session 回读。
