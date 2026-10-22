# 第 3 轮：最终源码验证

环境：Windows 11 / PowerShell 7，仓库锁定 native profile（`test/fixtures/native-profile/package.json`，DSH 0.2.1-alpha.2）。测试使用临时库与受控模型响应，未连接真实钉钉和业务数据。

## 可复跑命令

在仓库根执行，先按仓库文档安装依赖及 native 测试 profile：

```powershell
$env:DSH_NATIVE_TEST_PROFILE=(Resolve-Path test/fixtures/native-profile/package.json).Path
$unit=Get-Content docs/acceptance/coordination-review-repair/round-3/unit-files.txt
node --test --test-reporter=spec @unit
pnpm test:release-smoke
$native=Get-Content docs/acceptance/coordination-review-repair/round-3/native-files.txt
node --test --test-concurrency=1 --test-reporter=spec @native
node --test --test-reporter=spec test/task-notification-retry-native.test.js
node scripts/test-suites.mjs check
```

顺序执行，打包期间保持源码冻结；不修改测试 timeout。

## 结果

- unit-tests.log：307 PASS，0 FAIL，0 SKIP。覆盖 R1–R3/F1–F3、通知许可、未知投递与共享账本合同。
- release-smoke-profile.log：14 PASS，0 FAIL，0 SKIP。包括真实 tgz 任务执行、解压 Resident 启动/健康、产物清单与映射。
- release-smoke.log 是未设置 native profile 时的环境诊断：12 PASS、2 SKIP，不作为完整通过证据；显式使用仓库测试 profile 后全绿。
- summary-native.log：4 PASS，证明过期查询原生发信箱及重启不重发；最终收件人断言随下面完整原生组再次验证。
- native-tests.log：42 PASS，0 FAIL，0 SKIP，156.94 秒；覆盖真实 Host、持久化恢复、原 Owner 调度、计划和发信箱链路。
- notification-native.log：1 PASS，0 FAIL，0 SKIP；正式完成后退休确定未发送的确认，不重新派发。
- suite-check.log：299 文件各注册一次，3 个历史文件，0 删除；release 边界未减少。

最终四组共 364 项通过（307 + 42 + 1 + 14），零失败、零跳过。不同轮次的重跑不累加。

最终新增覆盖：过期摘要使用本次实例冻结的通知对象；取消受阻实例退出执行欠账，但未知投递仍保留待核对身份。
