# Round 3：发送边界修复及最终回归

修复：仅 `delivered` 保存已通知的业务指纹；starting/unknown 继续依靠原通知身份阻止重发。补充回归先 FAIL、后 PASS，防止发送许可冒充送达。同步协调看板和通知的版本失效文案，不再无依据声称需求变更；任务补充提示明确排除纯进度询问。

命令：设置 `DSH_NATIVE_TEST_PROFILE=D:/dsh_home/profiles/web/package.json`；`node --test --test-concurrency=1 test/coordination-summary.test.js test/coordination-observer.test.js test/independent-coordination-native.test.js`。

结果：127 tests，127 pass，0 fail，0 skip；63295ms。完整输出 `round-3-tests.log`。包括41项摘要/通知测试、协调投影和完整原生路由查询回包恢复。

其他检查：`node scripts/test-suites.mjs check` → verified 314 files; every file exactly once; historical 3; deleted 0。`git diff --check` 通过。long-goal 结构校验通过。

边界：未触发CI，未合并或部署，未进行真实模型语义测试或真实钉钉发送。未改原任务、原业务执行或正式 SQLite。旧通知停扰在隔离历史升级场景验证，需安装后才影响正式实例。
