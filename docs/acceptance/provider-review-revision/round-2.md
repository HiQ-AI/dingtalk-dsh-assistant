# 第 2 轮：修复与定向回归

- `node --test test/dynamic-task-store.test.js test/execution-provider-failure.test.js`：119 PASS、0 FAIL、0 SKIP。
- 设置 `DSH_NATIVE_TEST_PROFILE=D:/dsh_home/profiles/web/package.json` 后运行 `node --test test/task-session-execution-provider-recovery-native.test.js`：9 PASS、0 FAIL、0 SKIP，耗时 77.345 秒。
- 新增存储用例覆盖需求补充、冷却前拒绝、到期复核、幂等及重启、暂停/取消/未知操作门禁，原自动短重试仍拒绝旧版本。
- 新增原生用例覆盖短重试耗尽后补充需求、重启、当前统筹收到带时间和新旧版本的复核事件、同一 executionId/sessionId 显式续办。成功写入文件始终只有一行 once，operation 仅一条。

原生模型适配器为确定性夹具；使用真实宿主、会话、持久化和工具实现，不代表真实模型网络可用或业务代码已完成。部署与原任务恢复单独记录。
