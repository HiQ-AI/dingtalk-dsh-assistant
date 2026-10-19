# 第二轮

Node 24.19.0 / 本机原生 Web profile。

- `node --test --test-name-pattern='不同群成员|话题历史' test/task-session-service-native.test.js`：4 PASS，0 FAIL，0 skipped，24.6秒。跨作者补充带 requester 人工请求，旧请求 superseded 而非 answered；相同 task/session、来源作者保留、原拒绝决策恢复、二次重试幂等和缺准入拒绝均成立。
- `node --test test/task-topic-routing-native.test.js test/task-session-human-native.test.js test/topic-runtime.test.js`：125 PASS，0 FAIL，0 skipped，40.1秒。覆盖受信 Web 创建/修订、旧版本拒绝、群内原作者答复、私聊作者和引用核验，以及路由/恢复门禁。

曾扩大运行整个 task-session-service-native 文件，执行到不相关的上下文多代测试后未返回，终止本轮精确测试 PID 70032/38056，没有操作业务实例；该次不计通过。按项目定向测试规则改跑上述用例。第一轮 Web 回归失败已经修复并在本轮通过。

基于现场已安装的 PR #207 分支（1af646b）继续构建，保留 Provider 复核与列表回读修复；本次取消任务仍要求原所有者/配置负责人，同群补充和重新打开任务不再限制最初作者。
