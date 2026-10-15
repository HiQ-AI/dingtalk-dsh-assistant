# 第 2 轮

`node --test test/task-notification-delivery.test.js test/task-notification-readback.test.js test/task-completion-notification.test.js`：47/47 PASS。覆盖列表边界、围栏、英文空格、内容/身份错误拒绝、unknown 不发消息及正式结清路径。

`git diff --check` 通过。9 条实际消息的回读材料在修复代码下全部通过。当前尚未部署；原任务已恢复运行，排空检查返回 DEPLOY_NOT_DRAINED，继续等待。

补充原生回归：设置 DSH_NATIVE_TEST_PROFILE 指向当前本地 profile，运行 task-session-job-recovery-native 的 operator exact error resolution。修正脚本模型未区分 Topic 摘要调用的问题后，旧源码在告警消除断言失败；修复源码 1/1 PASS，0 skip。完整验证 HTTP check 零写、错误摘要拒绝、原操作失败审计、一次效果调用、同 execution/session 续办与告警刷新。

后续现场：原执行 inputVersion=2 已成功并排空；新的凭据入口要求只读核验，但复用已完成续办的 key 并改变 objective，被既有幂等保护拒绝。澄清 task_delegate 的单次请求 key 与 executionId 身份语义，不放宽派发冲突检查。回归验证旧键改目标拒绝、新步骤键继续同 execution/session、输入版本递增且执行数不增加。部署后正式回复当前 operator 申请，授权仅沿原任务核验新输入，不重放既有构建/提交/通知。
