# 第 5 轮集成回归

冻结候选后设置 `DSH_NATIVE_TEST_PROFILE=D:/dsh_home/profiles/web/package.json`，执行：

```powershell
node --test --test-concurrency=2 test/task-session-service-native.test.js test/task-session-provider-native.test.js test/task-session-progress-native.test.js test/task-dialogue-native.test.js test/coordination-reorder-native.test.js test/task-session-model-native.test.js
```

结果：68 项中 67 PASS、1 FAIL、0 SKIP，退出 1。前后受测源码、测试、锁文件与 profile 摘要一致，原始记录为 `round-5-integration-start.json`、`round-5-integration-exit.json`、`round-5-integration.log`。通过项覆盖普通任务调度、运行中反馈、资源排队、原执行续办、任务对话、顺序预评估、模型错误恢复及巡检；不重复跑已通过项。

失败项 `empty owner recovery reviews the retained execution without replaying its completed native write` 在 15 秒的内部等待断言处超时。快照没有 humanRequests、humanReviewLease 为 null，原写入及两项核验均 succeeded、工具错误为空、统筹尚未排空。该快照不能独立证明原因或最终成功，继续单例取证。

`node scripts/test-suites.mjs check` 另退出 0：308 个测试文件恰好各登记一次，历史 3、删除 0；本命令没有运行 CI。

同轮技能长路径新增 4 项检查和实际检出预检通过，详见 `round-5-skills.md`。它不覆盖或取消上述集成失败。
