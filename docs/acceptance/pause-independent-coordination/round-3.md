# 第三轮

环境：Windows 11、Node v24.19.0、pnpm 10.13.1。依赖按 `pnpm install --frozen-lockfile` 安装，原生测试使用 `DSH_NATIVE_TEST_PROFILE=D:/dsh_home/profiles/web/package.json`，独立临时目录，不使用生产账、不发送业务群消息。

1. `node --test --test-name-pattern='整体暂停协调会话|context shares exact bounded inputs' test/independent-coordination-native.test.js`：2 tests、2 pass、0 fail、0 cancelled、0 skipped。旧启用配置下协调候选被拒绝，普通路由可重提；历史协调成员与 prepared 通知不变；协调阶段和通知手动重试被拒绝；普通任务仍可补充。
2. `node --test test/task-topic-routing-native.test.js`：13 tests、13 pass、0 fail、0 cancelled、0 skipped。覆盖普通话题、原任务批量续办、Web 版本拒绝及重开、混合消息 Host 失败后重试。
3. `node --test test/independent-coordination-recovery.test.js test/coordination-migration.test.js`：49 tests、49 pass、0 fail、0 cancelled、0 skipped。验证保留的底层协调模块与迁移合同；这些直接调用模块的测试不表示当前 Host 装配或启用独立协调。
4. `node --check packages/dingtalk-dsh-assistant/task-session-service.js` 与 `git diff --check`：通过。

未运行全量测试或全部旧协调启用集成用例；未触发 CI、未合并、未部署，未做真实钉钉验收。已交办给原 Task 的工作不因暂停协调服务被取消。当前暂停为 Host 装配边界，保留的底层源码可供未来重新设计。
