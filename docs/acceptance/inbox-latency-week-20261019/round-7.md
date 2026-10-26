# 长续办超时完整基线对照

本轮修正的是测试总预算，不改变消息、Task或执行控制语义。round-6完整组合的62 PASS/1 CANCELLED历史保留，不改写成通过。唯一goal/shared-tasks/matrix仍在原任务根；本文件只存工程证据，不是第二份权威进度。

## 结论与反证

`32 continuations` 的原120秒总预算无法覆盖本机真实原生32代和独立核验。不是只因当前实现到期：完整0535038源码、原测试、原fixture、独立冻结依赖也在同一120秒门槛取消。临时诊断窗口内，两者均持续推进到32代并保留全部业务断言通过：当前139149ms、完整基线144835ms；第32代首次Owner分别在121067ms、126369ms，原deadline早于收尾核验。

- 已排除的候选：没有无限重复同一inputVersion；当前与基线都观测到1至32全部代次；全部断言最终通过，不是业务失败被放宽。
- 未获支持的候选：本轮计时引入该超时，或本轮引入明显续办变慢。完整基线也超时，本轮诊断反而较短；单次墙钟不能量化细微退化，也不能声称本轮提速。
- 采用的修正：只将该用例总预算由120000改为240000；原ownerSteps界限、32代数量、3个执行、未知效果、权限和上下文大小断言原封不动，不改生产代码、模型策略或执行重试。

源头证据：`round-6/clean-base-proof.json`核全部3314文件（81原始blob一致、3233仅LF→CRLF）；`round-6/continuations-diagnostic.json`仅保存逐代耗时/数量，不含原生身份、工具正文或业务消息。基线目录由archive生成，安装453包，不链接主检出node_modules。双方隔离profile预检37模块、credentialsLoaded=false。

## 再生成诊断

正式回归不用loader。仅定位时可用 `scripts/trace-native-continuations.mjs`：该loader只改目标测试观察窗口到600秒并输出代次/时间，不替换生产模块；脚本已检查作用范围、幂等和每一行原assert保持不变。早期临时诊断日志包含本机fixture路径，只留本机，不进PR；归档脚本仅输出代次/状态元数据。

```powershell
$env:DSH_NATIVE_TEST_PROFILE=(Resolve-Path 'test/fixtures/native-profile/package.json').Path
$loader=(Resolve-Path 'docs/acceptance/inbox-latency-week-20261019/scripts/trace-native-continuations.mjs').Path
$loaderUri=([uri]$loader).AbsoluteUri
node --experimental-loader $loaderUri --test --test-name-pattern='32 continuations bound owner Host input' test/task-session-service-native.test.js
```

完整基线须先导出0535038并独立 `pnpm install --frozen-lockfile`，将profile和test两路径指向基线目录；不能以当前测试+部分生产模块替换冒充完整基线。

## 正式回归

以下为无loader、完整隔离profile的原三文件组合，包含完成竞态、授权恢复、协调契约/公平续行、真实shell、32代、原生服务启动/销毁与故障恢复。正式结果已回读：63 tests / 63 pass / 0 fail / 0 cancelled / 0 skipped，duration_ms=627994.1744；其中32代142662ms。源头日志为 `round-6/full-native-budget-fixed.log`。本轮通过发生在round-8两项审查修复之前，不能代替修后回归。

```powershell
$env:DSH_NATIVE_TEST_PROFILE=(Resolve-Path 'test/fixtures/native-profile/package.json').Path
node --test --test-concurrency=1 test/coordination-latency-native.test.js test/independent-coordination-native.test.js test/task-session-service-native.test.js
```

## 交付边界

未push/创建PR；用户要求未排除回归前不建PR，本轮严格遵守。API直连已明确返回当前正常分支no pull requests found；本轮检查时Git HTTPS远程仍Connection reset；后续round-8单命令直连已恢复，不能把历史故障当当前阻塞。原任务根写入再次被worktree隔离门禁明确拒绝，仍未同步，未通过脚本或队友绕过。不触发CI、不合并、不部署、不重启、不重放真实消息或外发。
