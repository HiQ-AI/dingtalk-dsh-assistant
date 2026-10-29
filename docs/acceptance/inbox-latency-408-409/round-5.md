# Round 5 — Native task-session recovery tests

日期：2026-10-29（Asia/Shanghai）

## 定向回归

- 命令：指定 native profile 后运行 `node --test --test-name-pattern='native service cancellation stops|native requirement update resumes|recovering an idle owner|empty owner recovery reviews' test/task-session-service-native.test.js`。
- 汇总：tests 4、suites 0、pass 4、fail 0、cancelled 0、skipped 0、todo 0；duration_ms 43101.1186；exit 0。
- 覆盖：本地进程取消；旧执行结果被 fence；空闲 Owner 不占执行槽；已完成 native write 不因恢复而重放。
- 使用临时根目录及通知桩，不访问正式库或现场。结果来自测试方对指定 profile 命令的回报；未提供精确源码 SHA /完整逐项 stdout，故只记录定向套件通过，不外推部署或钉钉现场行为。

## 边界

- 此套件验证 task-session service 的原生本地测试路径，不等价于对真实钉钉消息、正式数据或业务通知的现场验收。
- 不覆盖 #408/#409 消息重放、生产运行或用户数据操作。
