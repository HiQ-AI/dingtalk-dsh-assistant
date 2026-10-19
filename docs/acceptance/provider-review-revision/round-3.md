# 第 3 轮：本机部署与原任务恢复

按 docs/ops/task-session-clean-start.md 的静止实例双包流程执行，Check 返回 writes=0、signals=0、40 个会话已排空、未知操作 0。原 PID 59384 经 SIGINT 退出，离线回读 remainingDescendants=0，保留原数据库和全部失败记录，未建立历史备份。

包与安装独立回读：

| 对象 | SHA256 / 结果 |
| --- | --- |
| Assistant 2.0.1 | 7daa9ea0d8eb6c5355a5c9bfc06597fe8c37100225b3ecf3144fddda6484eae0，54 文件与源码及安装一致 |
| Observer 2.0.1 | 6c80551e2bafdd73125b20f992390f3d077993c45845b04b705e7c8c6168a5d6，4 文件与源码及安装一致 |
| profile 原字节 | aa38870b121ee6aec20e7beb69f10ebe79af017a356b4fe9ca177ab916a588fc |
| 新 PID | 72024，双端口就绪，inboundProcessing=true、dwsBridge.healthy=true |

`/health` 为 degraded、recoveryIssueCount=1；独立读取 `/state/recovery-issues`，唯一问题为另一任务 task-6818916367cb2acf4cce15ddba1be6fd 的既有完成通知未知，未重发或修改该通知。

原任务 task-1a0c02d986c338f4a03a0a1d12113e5c 的恢复复核于 2026-10-19T08:17:59.257Z 落账。独立 API 回读确认 executionId=763a3009-cbd0-4bca-995b-0938c6865aef、sessionId=task-execution-216054d0-00a4-4f02-a8c9-e4f748294368 均保持，状态 running，requirementRevision=2，inputVersion/leaseEpoch=5，attempts=3、coldAttempts=1、reviewAttempts=1。

原生 session.v4.jsonl 独立回读：user/message seq=317 绑定上述原会话及 inputVersion=5、requirementRevision=2、controlRevision=1；inputDigest=19c147b80dbbbef0d52f553a899e2f84051f8c61365ad7e60445e8b69e349e63。此证据证明原会话已实际接纳续办输入，不表示业务修复或测试完成。
