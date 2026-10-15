# 后台 job 阻塞修复、本地部署及原任务验证

> 状态：ACTIVE
> Goal ID：native-background-receipt
> 最近维护：2026-10-15T11:15:00+08:00
> 权威目标：D:/codex/worktrees/native-background-receipt/dingtalk-dsh-assistant/docs/acceptance/native-background-receipt/goal.md

## 总目标

修复显式后台服务阻塞工具回执的问题，部署本地并推进原专家撤回修复任务的隔离验证。

## 完成条件

- 真实原生后台服务可被后续工具使用，退出和取消均有真实收据及排空证明。
- 双包部署读回、原调用终态和同任务恢复均有独立证据。
- 回查原任务业务验证与清理结果，区分技术恢复和业务验收。

## 范围与约束

- 保留 operation-dd0590820dd7589b071f8caeb85284f5c19dba8f、pwsh-10 和原会话；不重放启动和 edit，不改共享/生产环境。
- 主检出已有修改不动；无历史副本备份。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | 修复及定向验证 | 后台、终态、取消、隔离测试通过 | 完成 | round-1.md、round-3-native.log；119通过 |
| SG2 | 原调用排空及本地部署 | 原调用真实终态，包/进程/健康独立读回 | 进行中 | original-after-stop.json；原job已completed |
| SG3 | 恢复原任务并验证 | 原 session 继续，业务测试和清理有真实结果 | 进行中 | original-predeploy.json；原执行已开始数据库回归 |
| SG4 | PR交付 | 测试证据自包含，真实PR状态读回 | 待执行 | 待验证 |

## 当前检查点

- 当前子目标：SG2
- 唯一下一步：等待原执行当前隔离测试正常结束并排空，再双包部署。
- 未闭环项：部署、旧edit对账、业务验收与PR。

## 进展

- 2026-10-15：现场确认原操作 starting、pwsh-10 running、PG PID62532；独立审查确认回执等待与每调用清理两层问题。
- 2026-10-15 11:15：119项本地定向测试全绿，复审无阻断问题。正常停止精确PG后，原operation自然succeeded、pwsh-10 completed/exit0。原执行同session继续，已明确以启动-回归-finally停止的独立后续生命周期测试同一pgdata；原收据保持不变。

## 重大决策

- 显式后台及时返回；前台超时提升继续等待终态。旧闭包不能靠换包释放，需先真实停原专用数据库并保留原账。

## 重要信息

- 原 task 为 task-4c4780a541c5ea7c51024975de5f121d；原 execution 为 bdb7b510-4a09-4cd3-9a06-8ac8dda42608。
