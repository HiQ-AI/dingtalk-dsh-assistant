# 第 10 轮：通知恢复集成

执行 `node --test --test-timeout=30000 --test-reporter=spec --test-name-pattern='通知|材料清单|任务关联摘要' test/runtime.test.js test/topic-runtime.test.js`，29/29 通过。原始输出见 round-10-notification-tests.txt。

完成与通知分离、稳定 Outbox 身份、非法草稿与存储故障、恢复及关闭屏障、材料分页和关联 JSON 契约通过。真实 DWS 网络未调用；外部投递为隔离替身。
