# 等待期间事实追问

## 结果

既有 `humanReview` 的 `wait` 原本只有内部决定，没有事实回复通知出口。本轮复用 `task_session_submit`，新增可选 `replySourceId`，从当前只读复核候选中选择要回答的追问。Host 只公开 `summary`，保留原申请、内部证据和只读权限；通知与追问审计记录原子落账，并复用现有通知发送、回读与重试。

原生宿主场景实际走到发送适配器及独立回读，账本为 `delivered`；没有向真实钉钉群发送消息。模型由确定性夹具驱动，因此验证的是协议、工具和宿主行为，不宣称真实模型语义识别准确率或线上响应耗时。

## 验证

- `node --test test/dynamic-task-store.test.js`：119/119，通过，见 `followup-store-full.log`。
- 随后补充精确引用与提及身份校验，`node --test --test-name-pattern='待答事实追问' test/dynamic-task-store.test.js`：1/1，通过，见 `followup-store-identity.log`。
- `$env:DSH_NATIVE_TEST_PROFILE='D:/dsh_home/profiles/web/package.json'; node --test --test-concurrency=1 test/task-session-human-native.test.js`：13/13，通过，零跳过，88.681 秒，见 `followup-human-full.log`。
- `git diff --check`：通过。

新用例覆盖：原问题及任务/会话/需求/控制身份不变；相关事实追问读取原执行结果并引用回复；公开内部编号被拒绝且内部证据保留；原生提及精确指向追问作者；原执行没有续办、新写操作没有产生；无关来源不解除也不额外回复；崩溃发生在原子保存后、wake ack 前时不重复处理；后续真正答复仍可解除原问题。存储负例包括旧租约、错误请求/来源、跨群通知、旧来源版本、伪造引用、错误提及和空证据。

## 失败与修订

初始新原生夹具错误地把 `task_execution_read` 的引用当成完整执行结果，继而将已被上下文去重的 `document` 引用当作实际执行文档，再次只读到元数据，造成断言失败或有界恢复超时。保留 `followup-focused.log`、`followup-native-debug.log` 和 `followup-native-debug-2.log`。最终按原生 `record.contentRef` 精确读取 `/result/payload/output/summary` 后判断，单项复验通过（`followup-native-debug-3.log`），移除临时调试输出后整文件通过。没有删除失败断言、放宽产品权限或跳过业务路径。

## 改动边界

修改 `task-session.js`、`task-session-service.js`、`dynamic-task-store.js`、对应两份测试及人工介入 API 文档；同时按统筹要求接入其 `installSessionSkillRefresh` helper 与阶段重读指导。不新增等待机制、公开写 API 或数据表，不部署、不触发 CI、不提交或推送。
