# 第一轮：契约集成

命令：node --test --test-reporter=spec test/runtime.test.js test/task-reports.test.js test/report-native-lifecycle.test.js test/topic-runtime.test.js test/tool-schema.test.js

结果：255 项，254 PASS、1 FAIL。原始输出见 round-1-tests.txt。

失败：异常报告抢占待审计划时，task_checkpoint_review_superseded 未归入 stale，未知错误保护将 Task 转为 system waiting，导致后续诊断不能推进。修复：显式把该确定的失效错误码加入历史归档分类，不扩大业务拒绝白名单。

本轮没有迁移真实存储、运行真实渠道或部署。
