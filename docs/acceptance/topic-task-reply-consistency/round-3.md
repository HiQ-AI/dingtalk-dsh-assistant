# 最终定向验证

环境：Windows 11 / PowerShell 7 / Node 24；`pnpm install --frozen-lockfile`。原生测试使用已安装 DSH profile，通过受控模型决策驱动真实原生宿主、任务库、话题账和会话持久化，未使用真实业务外部效果。

命令：设置 `DSH_NATIVE_TEST_PROFILE` 为本机已安装 profile 的 package.json，然后 `node --test test/topic-runtime.test.js test/task-session-service-native.test.js test/task-session-control-host-admission.test.js test/task-session-http-integration.test.js`。

结果：139 tests，139 pass，0 fail，0 skipped，约 171 秒。

覆盖动作拒绝零回复、动作提交后异常恢复、回复入口失败仅补回复、历史自身通知、同账号人工补充、未准入来源拒绝、显式原消息恢复、重复恢复幂等，以及原生任务与执行生命周期/来源授权和 HTTP 路径。

独立 `git diff --check` 通过。Assistant 精确包 SHA256：`2443c58e41ced7735691543fb3185339c7e842546f1e8b7ae0c31241f6987a57`。Observer 使用同检出源码重打包，无 UI 改动；SHA256：`b67253f63c0f28151e9e41b209229b2fda0d3827de27fd0720fa8cd69fd45d74`。已独立读取包字节数及摘要。

原生部署 `-Check` 返回 checkOnly=true、writes=0、signals=0；账本 drained=true，3 个持久会话已核验，无 unknown 操作/通知。正式部署及真实原消息恢复另记后续轮次，不以本轮测试代替运行验证。
