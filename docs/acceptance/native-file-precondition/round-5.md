# Round 5

命令：设置DSH_NATIVE_TEST_PROFILE指向已安装完整profile的package.json，然后node --test test/dynamic-operation-readback.test.js test/dynamic-task-store.test.js test/task-native-unknown-fence.test.js test/execution-provider-failure.test.js。

结果：127 tests / 127 pass / 0 fail / 0 skipped，见round-5.log。覆盖9类文件前置拒绝、错误日志/身份/参数/摘要/取消反例、旧账事务对账及续办、真实Host edit/write拒绝后读取并在同一session完成、同操作派发去重、独立终端调查及provider分类。

补充命令：node --test --test-name-pattern='anonymous field v12 error restores' test/task-session-execution-provider-recovery-native.test.js。1 pass / 0 fail / 0 skipped，见provider-field.log；同execution/session保留完整诊断，effect.txt仍仅once，无人工申请。

边界：所有原生测试使用已安装Host与脚本模型执行隔离任务，无真实模型服务请求、业务文件变更、钉钉发送或业务UAT部署。未安装本轮插件、未改正式旧unknown、人工作答或业务任务状态。扩展旧冷恢复用例超时未收敛，因此不生成全绿report.md。
