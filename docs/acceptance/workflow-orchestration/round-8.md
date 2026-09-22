# 第 8 轮：通知与材料缺口

筛选命令：`node --test --test-reporter=spec --test-name-pattern='材料清单|通知草稿|通知写入持续|一次完成审阅|通知已入 Outbox' test/runtime.test.js test/topic-runtime.test.js`。

7 项中 6 通过、1 失败。非法通知草稿不回滚业务成功、重启只恢复固定通知身份、存储持续故障不产生未处理拒绝、材料当前 surface 分页与压缩反例均通过。FIFO 旧夹具未显式让叶子到 idle，下一任务仍 queued，不能用工具返回替代排空；后续补真实 begin/finish 步骤模型并保留延迟 idle 反例。输出见 round-8-notification-tests.txt。
