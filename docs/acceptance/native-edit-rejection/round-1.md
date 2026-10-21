# Round 1

- `node --test test/dynamic-operation-readback.test.js test/dynamic-task-store.test.js`：130 PASS，0 FAIL/skip。
- `DSH_NATIVE_TEST_PROFILE=<已安装Host>/package.json node --test --test-name-pattern 原生文件前置拒绝 test/task-native-unknown-fence.test.js`：edit/write/edit-noop 3 PASS；同会话读取纠正后任务完成、无人工申请。
- 对原 task-350707e02aa594904ea559efb562bd21 持久日志运行只读检查：operation-2c1c56470a5f5a025e5f67407f6588fdd0b15313，NATIVE_EDIT_ARGUMENT_REJECTED，noEffect=true，resultSequence=572，turnEndSequence=648。
- 宽范围原生 job recovery suite：9 PASS、1 FAIL、1 cancelled。重启收据用例在 origin/main 无修改基线上复现（expected succeeded, actual failed）；串行用例单独重跑 PASS。没有将宽 suite 声称全绿。
- 本地静止实例原生双包部署：预检 writes=0/signals=0/drained=true；旧 PID 73660。Assistant 包 SHA256 `7583ee0a4cf0f52abb35abb8ff34ef7e891d9da8172eac5e33d109b030f93cb0`；安装后 54 文件校验通过，Observer 原包校验通过。当前等待新进程健康及原任务终态。

完整日志和部署回执位于本工作树 docs/tmp/native-edit-validation/，不将本机配置和大量原生日志提交仓库。

最终独立回读（北京时间 2026-10-21 11:45）：新 PID 16740 同时监听 3080/18998，/health status=ok、recoveryIssueCount=0、inboundProcessing=true、DWS bridge healthy。SQLite 只读回读原 operation=failed，result.reconciled=true、errorCode=NATIVE_EDIT_ARGUMENT_REJECTED、noEffect=true，previousObservation 保留原 unknown；原 proof resultSequence=572/turnEndSequence=648。

原 task 状态 completed，完成时间 2026-10-21T03:45:24.071Z；requirementRevision=2/controlRevision=2/sessionId=task-session-f5cc250f-c9fe-4915-992e-67b8c6a3849f 均保持，leaseEpoch=16。原两条执行未新增或重放；completion:task-350707e02aa594904ea559efb562bd21:2 通知为 delivered。业务 PR #356 仍 OPEN，head=92cdf421a656d49bf364d0445832e2c93afb2882，未合并或部署业务服务。
