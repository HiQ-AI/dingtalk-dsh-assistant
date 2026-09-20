# 第一轮验证

2026-09-20。在独立 worktree 运行 `pnpm install --frozen-lockfile`，随后执行 `node --test test/runtime.test.js test/task-result.test.js test/topic-runtime.test.js`，187 项通过、0 项失败；执行 `pnpm test`，433 项通过、0 项失败。

新增及修订的用例覆盖：旧 `coordination` 新提交拒绝；空 `blockedItems` 不得批准等待；误把他人后续检查写入阶段时，resident 基于来源修订完整目标并保留已完成阶段；可继续工作时保持 Task 和 Goal 运行且无阻塞群通知；历史等待结果重启可读、通知补偿不重发；既有信息等待、人工授权和并发恢复仍通过。

只读执行 `node docs/acceptance/leaf-owned-completion/scripts/check-waiting-tasks.mjs --check`，在线 `/state/tasks` 共 56 个 Task，waiting 候选 0；因此本轮没有可受控修订的现存误阻塞任务。仍有运行中任务，未重启本机服务。真实模型语义判断和真实群投递尚未验证，不能由测试夹具替代。
