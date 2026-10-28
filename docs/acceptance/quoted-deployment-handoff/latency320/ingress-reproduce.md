# 再生成配方

工作目录为本worktree仓库根，PowerShell 7、Node.js 24+，已安装workspace依赖。测试日志全部在本目录，不打印资源内容或profile。

```powershell
node --test test/task-message-projections.test.js test/dynamic-task-store.test.js *> docs/tmp/quoted-deployment-handoff/latency320/phase-tests.log
$env:DSH_NATIVE_TEST_PROFILE='D:/dsh_home/profiles/web/package.json'
node --test --test-name-pattern='入站细分时钟' test/task-session-service-native.test.js *> docs/tmp/quoted-deployment-handoff/latency320/phase-native-tests.log
node --test test/observer-client.test.js test/web-client-build.test.js *> docs/tmp/quoted-deployment-handoff/latency320/phase-ui-tests.log
```

同图实测脚本native-ingress-probe.mjs使用本机既有profile、实际DWS只读下载、真实nativeTaskHost附件与消息入站。需要经明确授权才重新访问该业务资源，不作为默认测试命令；它包含原始群/消息/media定位信息，不应把脚本或运行隔离库作为公开附件。可公开结果仅native-ingress-probe.json，它只保留无内容时钟、附件摘要和尺寸。初始化前选全新隔离目录（当前root为本目录/native-ingress-state），不要复用已有probe目录，不指向现场任务或附件存储；保留该脚本所有发送/回读拒绝断言。脚本读取现有DWS配置，不登录、不输出凭据；YAML中js标记按无执行scalar读取。

当前probe没有部署/重启，也没有创建真实业务源。若原现场授权不延续，使用native case的合成PNG做本地验证；不能把合成测试称为同图/DWS实测。
