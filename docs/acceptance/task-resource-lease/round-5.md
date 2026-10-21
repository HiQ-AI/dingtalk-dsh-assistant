# 最终候选定向复验

固定核心候选后，沿相同已安装 DSH profile 依次运行，不与其他原生套件争用测试时间预算：

```powershell
$env:DSH_NATIVE_TEST_PROFILE='D:/dsh_home/profiles/web/package.json'
node --test test/dynamic-task-store.test.js test/dynamic-execution-resources.test.js test/task-session-observability.test.js
node --test --test-name-pattern='native shared resources|native delegation rejects changed keys|native capacity queues|native service cancellation|native executor resumes|native service reopens an unknown notification' test/task-session-service-native.test.js
node --test test/task-session-package-native.test.js
```

| 套件 | 结果 | 证明范围 |
|---|---|---|
| 账本/资源/观测 | 112 PASS，0 FAIL/SKIP | 包括全部 17 项资源行为、资源状态投影及相邻账本合同 |
| 相关原生生命周期 | 9 PASS，0 FAIL/SKIP | 同资源排队、异资源并行、实际文件写入、四档容量、取消、续办、未知通知不重发 |
| 实际 npm 包 | 2 PASS，0 FAIL/SKIP | 打包解压后加载外部 skill 执行任务，解压 Resident 实际启动健康 |

资源查询新增用例使用 12 个执行、每个 2 个键，核对 6 held/6 waiting；计数实际 SQLite statement 的读取，list/get/blockers 每次资源表读取均 ≤1。释放并由等待者取得资源后，再查任务过滤 list/get/blockers，仍满足上界且读到新持有者，证明没有跨请求陈旧缓存。没有把实现字符串包含某关键词当测试。

原打包超时项单独运行 8.5 秒通过，另一解包启动项约 5.8 秒通过。保留上一轮超时记录；本轮没有延长该既有用例的超时或改包实现刷绿。原始输出分别为 round-5-store.log、round-5-native.log、round-5-package.log，留在现场不入库。

独立回读实际安装 skill 七个修改文件 SHA256 全部匹配记录；健康脚本 SHA256 为 `4f6a775ad4dfa907893c996e9dd82e5e19ea77e5c79cc07c9d89046c44860ddc`，runbook 为 `b0695e08925f4a37a0bc40b3c202776db628dbf02ad60080e2408dde2a8f8859`。静态与 HTTP/GET 验证分别见 companion 报告，不把它们计入插件原生用例数量。
