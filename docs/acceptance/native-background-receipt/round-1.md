# 第1轮：基线及修复验证

基线：现场原 operation starting，原 job pwsh-10 running，PID62532 使用原任务 round-3/pgdata。collectNativeJob 的终态等待与每工具进程清理共同阻止常驻服务供后续工具使用。

第一次定向测试 3 PASS / 1 FAIL：新增真实 HTTP 服务两场景通过；旧后台短命令测试新增 job_output 后 operation 总数由1增2，原测试错误地计入新增操作。只调整断言为对应 shell operation，未放宽原进程/输出/终态断言。

第二轮 26 PASS / 0 FAIL / 0 SKIP，证据 round-2-native.log。独立审查发现前台排空失败会跳过后台清理，修复并补回归。

最终本地实跑：

`$env:DSH_NATIVE_TEST_PROFILE='D:/dsh_home/profiles/web/package.json'; node --test test/task-session-job-recovery-native.test.js test/dynamic-execution-session-native.test.js test/dynamic-task-store.test.js test/dynamic-operation-readback.test.js`

119 PASS / 0 FAIL / 0 SKIP，证据 round-3-native.log。包含真实原生 HTTP 服务跨工具可用、显式/自动停止、前台提升、后台/前台取消排空、并行作用域、前台失败仍清后台、job原身份恢复与未知保护、文件前置拒绝对账。未把本地测试等同现场任务业务验收。
