# 每日插件优化实施验收

依据 `../../spec/plugin-daily-review-20260921.md` 顺序实施。先在 `worktree-plugin-daily-optimization` 隔离代码与真实 Profile；当日正在执行的 Task 不作测试重放。业务结果、Outbox 落盘、真实送达、Web 健康分别验证。

1. 内部审阅错误：区分返回的业务 reject 与抛出的系统异常；确定性预算故障保存 `failed` 报告、将 Task 置为 system wait、由 Host 生成稳定通知；同输入同错误的新报告被阻止；修复后显式重试原报告。
2. 工具结果观测：按当前 DSH `tool/result.data.message.content[0].isError` 和关联的 tool/call 记录工具名与真实错误；无法关联明确记 unknown。
3. 后续子目标按 `goal.md` 执行并补充独立回归；每项在 `matrix.csv` 留状态，结果放 `round-N.md`，全部完成再写 `report.md`。

安装前验收：稳定 v8 Storage `--check`、无运行 Task、包哈希、Profile 依赖、进程端口归属。只有全量测试和本地真实启动通过后才考虑切换；不得向真实群发送故障注入消息。
