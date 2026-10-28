# Round 2：集成验证与交叉审阅

命令：设置 `DSH_NATIVE_TEST_PROFILE=D:/dsh_home/profiles/web/package.json`，执行 `node --test --test-concurrency=1`，文件为 coordination-summary、coordination-schedule-revisions、coordination-observer、coordination-trigger-commands、coordination-final-fault-matrix、independent-coordination-changes、coordination-observed-prerequisites、independent-coordination-native、coordination-observed-native、coordination-notification-freshness、independent-coordination-recovery 的 `.test.js`。

结果：302 tests，302 pass，0 fail，0 skip；146097ms，完整输出 `round-2-tests.log`。原生运行依赖真实已安装 profile，但模型由隔离夹具控制，无正式群外发或原业务执行。

交叉审阅额外复现一处边界 FAIL：`start → aggregate → receipt(failed,knownNotSent:true) → 同业务状态诊断变化 → aggregate`，从未发送的状态被提前保存为已通知，得到 `newNotification:null`。这是本轮尚未通过项，必须修复后再结案；见 round-3。
