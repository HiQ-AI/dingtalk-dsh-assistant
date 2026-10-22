# 第 1 轮：原任务恢复与子会话绑定

## 现场恢复

- 正式 reply/check 返回 writes=0、resultSequence=1229、turnEndSequence=1611、investigationCount=1，原操作摘要 68f6435797b24087118fbd110f44d345adb1332b31a53f944fee56b1f55feb51。
- 同正文正式 reply 后独立 SQLite 只读查询：原 operation 为 failed，previousObservation.state=unknown，partialEffectsPossible=true，operatorSourceId存在，proof.kind=native-investigated-failure。
- 原 task/session 不变，第3轮于2026-10-22T01:38:17.940Z完成；完成通知独立回读 delivered，观察时间01:39:09.260Z，mentionVerification=unavailable。
- 后续群消息要求UAT2截图，原任务正式进入 requirement/control=4、runSequence=4，原执行继续取证。这是新增要求，不是旧unknown再次阻塞。不得据第3轮完成声称第4轮已完成。

## 复现与回归

- 修复前运行 `node --test --test-name-pattern='native child agents' test/task-session-persistence-native.test.js`：1 fail，TASK_SESSION_BINDING_REQUIRED，栈位于原生 AgentLoop.createStoredSession。
- 修复后同命令：1 pass，0 fail。
- `node --test --test-concurrency=1 test/task-session-persistence-native.test.js test/task-session-skills-native.test.js test/execution-session-native.test.js`：110 pass，0 fail，5 skip（缺少完整native profile；另行配置真实本机profile补验）。覆盖子会话创建、实际模型/子进程cwd、嵌套创建、同身份恢复，伪父/跨任务/错误父链/根会话借权恢复拒绝，原Host writer拒绝、目录链接拒绝与重启日志归属。
- `node --test test/dynamic-operation-readback.test.js`：34 pass，0 fail，0 skip。
- 完整profile首轮服务集成中的网页读取用例触发20秒超时；使用同profile定向复跑：1 pass，0 fail，0 skip（7269ms），保留首轮失败，不计为首轮全绿。

## 已知边界

- `node scripts/test-suites.mjs check` 报test_suite_map_stale。update预览仅新增既有task-boundary-instructions.js的56处闭包条目；本次源码与测试未改静态导入，属基线映射遗漏。已撤回预览生成的映射改动，不扩大本次修复。
- 本地部署预检报DEPLOY_NATIVE_TURN_NOT_ENDED；第4轮真实截图执行仍在运行，未停止实例、未安装修复包。安装代码与当前main还存在4个其他源码差异，不能用本次包覆盖未知在场变更。
- UAT2业务代码/部署未重放；未将原生fixture验证当成登录整站或真实截图验收。

## 补充验证

- 最终源码 `node --test test/task-session-persistence-native.test.js`：16 pass，0 fail，0 skip。
- 设置 DSH_NATIVE_TEST_PROFILE=D:/dsh_home/profiles/web/package.json 后，skills-native：5 pass，0 fail，0 skip，补齐原5项skip。
- 扩展集成的32次续办压力用例触发原120秒超时；本轮未取得该压力用例全绿，不把定向修复通过冒充所有集成通过。未扩大修改超时或断言。
- 扩展集成还记录原生工作区恢复（20秒）、容量队列 tasks=1/executions=1 与 tasks=2/executions=1（15秒）超时；这些均保留失败，未归因为本修复或环境，尚未收敛。原修复相关定向结果保持独立。
- 根因修复已提交ce293ca并推送；草稿PR #243回读OPEN，base=main、head=worktree-native-subagent-binding。现场health独立回读status=ok、recoveryIssueCount=0；第4轮截图执行仍active/running。
