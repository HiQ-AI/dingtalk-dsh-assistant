# 第 4 轮：有序列表分段编号

2026-10-19 原 completion 通知第 5 版仍为 unknown，sendAttemptCount=1。DWS 原发送任务查询 SUCCESS，精确原消息 msgeirS0jkArkW4aK66ZUN5Dw== 可读，群、发送者和原生引用均匹配。实际将第二列表项 `2.` 渲染为 `1.`；其余格式差异由既有 inline-code/无序列表规则处理。

新增两条测试，在 HEAD 基线源码下均 FAIL：sameDeliveredText=false、通知只产生 diagnostic 而非 reconcile。修复后 readback 文件 10 PASS。真实原消息使用修复后的完整 verifyTaskNotificationReadback 得到 send-receipt 身份证明，原 messageId 不变，mentionVerification=unavailable，sentAt=2026-10-16T01:41:15.000Z；此步只验证代码，未写通知账。

修复仅对原始顶层从 1 连续递增的有序列表增加“各项重置为 1”的候选，原项目正文和换行结构不变，再复用既有格式归一化。非连续/非 1 起始/嵌套/代码围栏不变换；正文数字、顺序、语义或身份变化仍拒绝。unknown 交付测试把 send 绑定为 assert.fail，证明只调用正式 notification.reconcile。

完整定向回归 `node --test test/task-notification-readback.test.js test/task-notification-delivery.test.js test/task-completion-notification.test.js test/group-reply-format.test.js test/workflow-notification-obligations.test.js`：130 PASS、0 FAIL、0 SKIP，耗时 50.814 秒。

现场部署结果在后续轮次记录。当前活动业务尚未排空，不强行中断部署。
