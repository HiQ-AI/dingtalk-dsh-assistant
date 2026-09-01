# 群消息 Decision 按 step 提交验收报告

## 结论

GD-01 至 GD-11 全部通过。群消息 Decision 已从 turn 末尾 assistant 文本提取迁移为 Resident 在任意 step 调用 `group_decision_submit` 的结构化提交；模型保留多消息关系判断权，Runtime 只校验请求归属、一次性提交和共享副作用。

## 关键结果

- 每条群消息即时 Steer 并携带不可猜测的判断请求 ID。
- 后完成的独立请求不受前一条 pending 阻塞；模型可分别提交，也可将相关请求组合为一个共享 Decision。
- 共享 Decision 的 Task/Outbox 副作用只执行一次，所有来源消息均进入 Task 证据信封。
- 普通 assistant 文本和 `turn/end` 不再是业务提交边界；未调用工具会明确失败。
- 重复、未知、跨群及非法结构在消费任何 pending 前原子拒绝。
- 本地 profile 安装文件与源码哈希一致，Web、Runtime、版本与群状态接口均健康。

## 验证摘要

- Web 构建无生成文件漂移。
- 全量测试：103 pass，0 fail。
- 发行包：3 个 tgz，数量与 CI 门禁一致。
- 本地运行：计划任务 Running；单一进程监听 3080/18998；Web 200；Runtime `status=ok` 且恢复问题 0。

## 未执行项

未向真实钉钉群发送测试消息。本报告不把健康接口或隔离测试表述为真实群业务 E2E；真实群消息将按正常业务流量使用新协议。
