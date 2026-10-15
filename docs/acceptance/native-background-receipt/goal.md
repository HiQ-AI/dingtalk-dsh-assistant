# 后台 job 阻塞修复、本地部署及原任务验证

> 状态：ACTIVE
> Goal ID：native-background-receipt
> 最近维护：2026-10-15T11:42:00+08:00
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
| SG2 | 原调用排空及本地部署 | 原调用真实终态，包/进程/健康独立读回 | 完成 | round-4/recovered-start.json；新PID42240 |
| SG3 | 恢复原任务并验证 | 原 session 继续，业务测试和清理有真实结果 | 进行中 | original-predeploy.json；原执行已开始数据库回归 |
| SG4 | PR交付 | 测试证据自包含，真实PR状态读回 | 进行中 | PR182 OPEN，待追加现场证据 |

## 当前检查点

- 当前子目标：SG3
- 唯一下一步：核对原execution输入版本2修正后隔离回归和清理结果。
- 未闭环项：业务验收及PR追加现场证据。运行时另有1条恢复告警，需分类说明。

## 进展

- 2026-10-15：现场确认原操作 starting、pwsh-10 running、PG PID62532；独立审查确认回执等待与每调用清理两层问题。
- 2026-10-15 11:15：119项本地定向测试全绿，复审无阻断问题。正常停止精确PG后，原operation自然succeeded、pwsh-10 completed/exit0。原执行同session继续，已明确以启动-回归-finally停止的独立后续生命周期测试同一pgdata；原收据保持不变。
- 2026-10-15 11:35：原隔离业务回归已运行两轮（5项/1错误；65项/1失败），均为夹具问题并由原执行修正。表/连接清理为0。现有技术申请已答复要求维护排空，原执行drained；第二次部署Check通过、原生SIGINT排空成功，正在安装双包。首次apply因缺锁目录在停机前失败，已修复部署脚本自动创建父目录并保留失败证据。
- 2026-10-15 11:42：双包安装后因Observer manifest格式化触发旧字节门禁误报，profile未变；旧Observer manifest与源码原字节摘要相同，新manifest语义及包内容均经核验。修正门禁，零写Check后完成原安装的启动阶段，没有重装。新PID42240，接入/DWS就绪，旧edit已原生对账failed/noEffect。维护完成输入已接纳；原execution同session输入版本2续跑。

## 重大决策

- 显式后台及时返回；前台超时提升继续等待终态。旧闭包不能靠换包释放，需先真实停原专用数据库并保留原账。

## 重要信息

- 原 task 为 task-4c4780a541c5ea7c51024975de5f121d；原 execution 为 bdb7b510-4a09-4cd3-9a06-8ac8dda42608。
