# 第 5 轮：消费端集成首轮

执行 `node --test --test-reporter=spec test/observer-client.test.js test/http.test.js test/topic-runtime.test.js test/task-progress.test.js`，120 项中 119 通过、1 失败。

失败是 observer 旧静态断言要求 completed 自动将全部阶段算完成。新契约必须按阶段证据计算，因此更新测试并由第 7 轮浏览器验证真实显示。原始输出见 round-5-integration-tests.txt。本轮不记整体通过。
