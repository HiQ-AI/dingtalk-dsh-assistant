# Round 13 — Native 语义模式与恢复定向验证

日期：2026-10-29（Asia/Shanghai）

## 结果

- 指定 native profile 下执行：`$env:DSH_NATIVE_TEST_PROFILE='D:/dsh_home/profiles/web/package.json'; node --test --test-name-pattern='real coordinator input enforces explicit context semantics|web acceptance reuses existing topic|Host exact recovery rejects unknown effects' test/task-session-service-native.test.js test/task-web-topic-reuse-native.test.js test/task-background-retry-native.test.js`。
- 共 6 pass、0 fail、0 cancel、0 skip，39308.2232 ms，exit 0。
- 覆盖协调输入的 missing/preserve/replan/cancel 四种 context mode、Web acceptance 复用原 Topic、Host exact recovery 对 unknown effects 的处理。测试脚本为真人回复指定目标；Host 直接持久化 decision 按合同包含 target 与 at 字段。

## 证据边界

使用临时数据库、脚本模型和通知桩，不是正式 LLM 或钉钉真实送达。此组定向通过不代表其他未执行普通确认、通知或恢复路径通过；不创建最终 `report.md`。
