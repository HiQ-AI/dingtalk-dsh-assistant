# 话题上下文只读入口

话题详情的“当前上下文与判断记录”使用 `GET /state/topics/:topicId/context?groupId=...`，不调用停用的 workflow 服务。页面布局保持不变。

响应读取原话题账的当前摘要、问题、来源消息及真实决策记录，并从当前任务会话读模型列出关联任务。来源消息明确标注为“来源消息”，不合成为推测的业务事实；没有旧工作流 carrier 记录时不伪造跳转来源。

`cursor` 为来源消息偏移，`intentCursor` 为决策偏移，`limit` 默认 50、最大 100；响应分别返回 `nextCursor` 和 `intentNextCursor`。后续分页携带响应的 `revision`，版本变化返回 409；缺少群身份返回 400，话题不存在或不属于该群返回 404。该入口只读，不恢复任何 workflow 调度或写权限。

定向验证：`node --test test/task-topic-context-http.test.js test/http.test.js`。
