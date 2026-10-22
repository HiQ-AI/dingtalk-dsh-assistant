# R18 原生执行按需拆分：实现记录

## 职责与边界

本执行负责移除生产源码中的团队人数上下限，以及直接 Store 回归。基线为 `origin/main` 的 `12f13e0`，实施分支为 `worktree-native-adaptive-team`；前置方案见 `docs/spec/native-adaptive-team.md`。

仅修改 `task-session.js`、`task-session-service.js`、`dynamic-task-store.js` 和 `test/dynamic-task-store.test.js`。README、运维文档、目标、原生 Host/服务测试和模型评估脚本由其他执行人维护。本执行未改 Claude adapter、已安装环境或现场账本，未调用模型、提交或推送。

## 实现结果

- `task-session.js:38`：统筹按复杂度、可独立完成性、依赖、共享写入和拆分成本选择直接处理、单执行或多执行。移除固定角色数量、简单任务强制凑人数及完成前人数达标指引；保留明确职责、原成员复用、独立就绪工作同轮委派、单写者、按风险核验和逐轮执行文档。
- `task-session.js:193`：提交工具说明改为核验完整目标及已委派结果，团队人数不作为完成条件。删除 `assertTaskExecutionTeamComplete` 导出，不保留空实现。
- `task-session-service.js:9/907/981`：删除人数校验 import 和 complete 前查询/检查；执行成员提示不再假定 3 至 10 人。实际完成仍走原 `task.complete`、授权来源和通知合同。
- `dynamic-task-store.js:896`：仅删除 `execution.dispatch` 累计 10 个身份上限，不新增人数配置，不改并发容量。
- `test/dynamic-task-store.test.js:183`：原上限测试改为 12 个真实 Store 执行身份均可登记、claim、提交及排空；同 key 重试仍去重，改目标仍拒绝冲突；原执行续办保留 execution/session 身份并升至 inputVersion 2，完成后重开数据库保留全部 12 个执行记录。

## 保留的完成与执行保护

`dynamic-task-store.js:159–165` 的 blockers/assertClear 未修改：非终态或未排空执行、未终态操作及旧账阻塞仍拒绝完成。task.complete 的未读反馈、对话和协调等待检查，以及执行身份/版本/租约校验、资源锁、unknown 不重放、原执行续办条件均未修改。已配置的最大并发容量仍由服务调度执行，团队累计人数不等于同时运行进程数。

## 验证

已运行以下命令，未放宽断言或超时：

```powershell
node --check packages/dingtalk-dsh-assistant/task-session.js
node --check packages/dingtalk-dsh-assistant/task-session-service.js
node --check packages/dingtalk-dsh-assistant/dynamic-task-store.js
node --test test/dynamic-task-store.test.js test/dynamic-execution-resources.test.js
```

三份源码语法检查通过。直接 Store 和资源保护回归首次运行 **123 PASS / 0 FAIL / 0 skipped / 0 cancelled**，耗时 **9373.558 ms**，原始日志为 `store-adaptive-1.log`。其中新的 12 人用例每轮 result 后、drained 前仍被 `DYNAMIC_TASK_NOT_QUIESCENT` 拒绝提前 complete；既有单执行取消/排空、unknown 保锁与不重放、同资源互斥、反馈未消费和版本失效反例同时通过。

该层验证使用生产 Store 与隔离 SQLite，执行结果由测试提交，**不代表启动了 12 个原生模型或完成了实际业务**。零/一/二执行的 service 完成路径、11 个原生执行受并发容量限制、真实文件与逐轮文档由本轮其他成员的 Host 测试提供证据。本执行没有真实模型决策验收或部署证明。

## 冻结与回读

测试结束后独立读取日志汇总、git diff 和文件 SHA256，生成同目录 `implementation-results.json`。生产变更仅 3 个源码文件；Store 上限以外的生命周期实现没有改写。当前源码与测试哈希如下：

| 文件 | SHA256 |
| --- | --- |
| task-session.js | de40b14728fc2aa0fa51e89b834c08c4791e465bf6809a7b84307c7811696807 |
| task-session-service.js | bc155957fc9fa5b72e9b3577e67ea99a1fcb00389436eb456c7d25ef51d4110a |
| dynamic-task-store.js | aaf903785578b07723d1b00a11b6a9cecc16c457ea2dff15699a258828bbd851 |
| dynamic-task-store.test.js | 29be421d204d338deead810fa0552faa1aed70dfd84cbe2926aaf88ce8edc9dc |

后续独立审阅由审计成员记录。本执行保留首次测试日志，不以其他层测试结果覆盖此处边界。
