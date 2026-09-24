# 第 1 轮：实施基线与验收准备

日期：2026-09-24。对应测试定义为 `../../spec/topic-intent-task-composition.md` 第 8 节，状态以同目录 `matrix.csv` 为准。

## 基线

- `origin/main` 独立回读为 `f1c3a13b090d6b81c409fea0f3512228d210c1b7`；从该提交创建 `worktree-topic-intent-composition`。主仓未跟踪文件保留。
- 旧 runtime-redesign PR #121 独立 `gh pr view` 为 `MERGED`，本轮使用新的分支。
- `pnpm install --prefer-offline` 在隔离 worktree 成功，依赖从本机缓存安装。此命令不证明业务功能。
- 设计方案从主仓只读副本复制到隔离 worktree，SHA-256 一致；该文件是待实施契约。
- 上一轮现有行为测试 2/2 PASS：R 未完时另一事项可先派发、执行中新输入换代屏障有效。这两项是旧机制基线，不计本方案验收 PASS。

## 当前判断

源码中 R/I/accept 尚在一个 unitDrive 中，Topic 在 I 后保存；单条消息串行 `processTail` 会使直接等待全群归类的做法自锁。实现需先拆分调度，再用持久状态与原子事务校验。Task 创建目前直接绑定一个 workflowId，缺少跨 run 的业务 Task 计划。

## 下一轮验证

优先执行 M01—M12 的单库竞态、权限与恢复反例；代码落地后逐案记录实际命令、断言和失败/通过证据。T/G 用例保持 NOT_RUN，不从底层模块测试推断跨流程业务通过。
