# 按需执行团队原生复验

## 职责及范围

修正R18原生测试夹具假设后，验证DSH默认执行的零/单/双/十一成员、原身份续办、逐轮文档及未排空/unknown完成保护。使用实际原生Host、持久化、文件与进程工具；模型由既有可控适配器给出调用，不访问真实模型、不操作生产现场。

## 修正与证据

R18首错保留于 `../round-18/native-adaptive-red-1.log`。完成拒绝的工具错误message为具体阻塞对象JSON；现在精确断言未排空执行taskId、drained，以及未知操作operationId、state。unknown反例复用现有job-recovery-native测试的工具回执丢失注入方式，真实写文件后由工具抛异常，检查持久unknown与唯一工具调用；不把shell非零退出当作unknown。未修改生产完成语义。

- `native-source-freeze-2.json` 对应串行定向复验 `native-adaptive-2.log`：7 PASS / 0 FAIL / 0 skip，exit 0，95.34秒。运行后3个生产文件及2个测试文件SHA均与启动冻结一致。
- 覆盖零执行咨询完成、单成员原执行/原会话恢复完成、两成员固定产物独立验收、十一成员实际文件写入与读取且并发不超过2、单成员两轮文档实际读取和旧轮SHA冻结、未排空拒绝后沿原任务完成、未知效果保持active且不重放。
- 十一成员用例首轮53秒但PASS；复验时曾把预算45秒改90秒。按统筹要求已恢复原45秒预算，业务逻辑及断言完全不变；最终源码冻结为 `native-source-freeze-3.json`，仅此用例重新验证于 `native-eleven-3.log`：1 PASS / 0 FAIL / 0 skip，exit 0，总运行49.27秒（含测试进程和清理）。其余六例逻辑未变化，沿用上述实证。最终5个源码文件独立SHA回读均与freeze-3一致。

## 命令

在本工作树设置 `DSH_NATIVE_TEST_PROFILE=test/fixtures/native-profile/package.json` 后执行：

```powershell
node --test --test-concurrency=1 --test-name-pattern 'owner injects one authoritative|native sequential handoff|native service runs eleven|native executor resumes|native board keeps|native single-member completion|native execution documents keep' test/task-session-service-native.test.js test/task-session-progress-native.test.js
node --test --test-name-pattern 'native service runs eleven' test/task-session-service-native.test.js
```

本轮只负责上述定向native验收；完整Store/资源回归、release-smoke、PR与部署由统筹分别取证，不能由此日志代替。

## 结论

本轮原生合同定向验收通过：执行成员数按实际工作需要选择，0/1/2以及11成员路径均可正常结束；DSH默认、原身份续办及历史文档冻结保持。未排空和未知效果仍被实际完成工具拒绝，unknown反例没有重放。没有提交、推送或部署操作。
