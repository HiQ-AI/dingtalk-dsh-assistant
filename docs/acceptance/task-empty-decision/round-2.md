# 定向验证

日期：2026-10-21；Node.js 24.19.0；PowerShell 7。依赖由 pnpm install --frozen-lockfile 安装，未修改锁文件。原生模块来源为本 worktree 的 test/fixtures/native-profile/package.json，通过 DSH_NATIVE_TEST_PROFILE 指定。使用真实 Host、Agent、会话持久化、SQLite、文件工具，仅模型返回由夹具控制。

## 模型恢复

`node --test test/task-session-provider-native.test.js`：12 pass、0 fail、0 skipped，退出码 0。

- 空 assistant 正常结束后记录 TASK_SESSION_NO_SUBMISSION/phase=decision，原 wake 保持 claimed，没有业务 blocked 或人工请求。
- 不补充用户输入、不主动 recover，真实计时器到期后原 session 在 lease 2 提交 complete；原 wake ID 保留并 ack，无新增执行或通知。
- 进程组合重建后预算保持，同一 session 自动恢复。
- 连续七次空返回后 suspended=true、nextAttemptAt=null；额外恢复扫描和时间推进不再请求模型。原生过载错误仍使用原预算，真实后续需求可恢复入口。
- 已提交决定优先、旧版临时错误精确证据恢复、配置错误及运行错误不产生热循环，均保持通过。

## 统筹服务和真实写入

首轮 39 项中 38 项通过。唯一超时用例和新增写入用例执行：

`node --test --test-name-pattern 'empty owner recovery|native capacity queues promote every task and execution: tasks=1, executions=1' test/task-session-service-native.test.js`

结果：2 pass、0 fail、0 cancelled、0 skipped，退出码 0。容量用例耗时 12.07 秒，未修改原 15 秒限制。

新增用例真实调用原生 shell 写文件一次，执行提交 succeeded 后统筹空返回；恢复统筹读取原执行再完成。断言文件仅一行 once、执行数量 1/inputVersion 1、成功操作 1、shell 工具结果 1。恢复系统指令确实存在，没有重派执行或重放写入。

## 边界

本记录证明源码和隔离原生 Host 行为，不代表本机运行包已替换、真实钉钉闭环或业务验收。未追溯改写旧版 blocked，未触发 CI、合并或部署。
