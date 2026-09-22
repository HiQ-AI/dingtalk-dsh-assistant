# 第 3 轮：结构化计划、检查器与迁移

执行 `node --test --test-reporter=spec test/task-plan.test.js test/task-result.test.js test/tool-schema.test.js test/task-checks.test.js test/workflow-migration.test.js`，28/28 通过。原始输出见 round-3-unit-tests.txt。

覆盖计划关联、工具必填、Host 检查器证据、文件边界以及真实 DSH JSON backend 的独立 v8→v9 转换。迁移检查零写、源摘要不变和目标读回由测试验证；未打开真实 profile。
