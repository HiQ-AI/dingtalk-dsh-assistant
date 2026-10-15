# 后台 job 阻塞修复、本地部署及原任务验证

> 状态：COMPLETE
> Goal ID：native-background-receipt
> 最近维护：2026-10-15T12:14:00+08:00
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
| SG3 | 恢复原任务并验证 | 原 session 继续，业务测试和清理有真实结果 | 完成 | round-12.md；原task completed/drained |
| SG4 | PR交付 | 测试证据自包含，真实PR状态读回 | 完成 | PR182 OPEN；round-12/pr-readback.json |
| SG5 | 修复原生job读取误记未知 | 固定读取身份及旧拒绝对账测试通过，部署并恢复原查询 | 完成 | round-10-native.log；round-11.md；原查询failed/noEffect |

## 当前检查点

- 当前子目标：SG4
- 唯一下一步：无；插件修复、本地部署、原任务隔离验证与状态回读已交付。
- 未闭环项：保留共享副作用未核实及完成通知读回unknown，不擅自回滚共享环境或重发通知。另有其他任务1条历史恢复告警；不声称全健康。

## 进展

- 2026-10-15：现场确认原操作 starting、pwsh-10 running、PG PID62532；独立审查确认回执等待与每调用清理两层问题。
- 2026-10-15 11:15：119项本地定向测试全绿，复审无阻断问题。正常停止精确PG后，原operation自然succeeded、pwsh-10 completed/exit0。原执行同session继续，已明确以启动-回归-finally停止的独立后续生命周期测试同一pgdata；原收据保持不变。
- 2026-10-15 11:35：原隔离业务回归已运行两轮（5项/1错误；65项/1失败），均为夹具问题并由原执行修正。表/连接清理为0。现有技术申请已答复要求维护排空，原执行drained；第二次部署Check通过、原生SIGINT排空成功，正在安装双包。首次apply因缺锁目录在停机前失败，已修复部署脚本自动创建父目录并保留失败证据。
- 2026-10-15 11:42：双包安装后因Observer manifest格式化触发旧字节门禁误报，profile未变；旧Observer manifest与源码原字节摘要相同，新manifest语义及包内容均经核验。修正门禁，零写Check后完成原安装的启动阶段，没有重装。新PID42240，接入/DWS就绪，旧edit已原生对账failed/noEffect。维护完成输入已接纳；原execution同session输入版本2续跑。
- 2026-10-15 11:54：核心数据库9项全绿。原执行追加全仓测试加载Spring local并连接共享服务，发现后经原任务停止排空，Java/Maven及专用PG退出；共享副作用未核实，不声称无影响。原execution/session inputVersion3继续仅限隔离Approval定向验证；16个候选测试文件无Spring上下文注解。
- 2026-10-15 12:04：回查全仓真实终态为400项/0失败/0错误/1跳过，11:52:06已自然完成，并非被取消；停止要求生效后原任务核对退出，不改写原收据。job_output读取已释放pwsh-7被误记unknown，根因是遗漏原生job读取的read身份。补固定定义、未来同名不受信标志及历史精确拒绝恢复；124定向测试通过。已核对原session选择standard preset、未变profile及原生tool-jobs来源；历史来源不能仅凭错误文字推断。
- 2026-10-15 12:10：最终包2168cc56已部署，新PID63408，原profile及DWS保持。原job读取正式failed/noEffect并保留原始账与正常结束证明；原execution/session inputVersion4整理最终交接。专用PG表/连接为0，系统监听55432为0。
- 2026-10-15 12:14：原task已completed/drained；原execution同session inputVersion4 succeeded/drained、业务输出completed。9项隔离DB/控制器及8项限定单测PASS，夹具/连接/监听清理已核对。PR182 OPEN且正文更新本轮真实结果。完成通知仍unknown读回未确认，未重发；连同共享影响限制如实交付，不生成全绿报告。

## 重大决策

- 显式后台及时返回；前台超时提升继续等待终态。旧闭包不能靠换包释放，需先真实停原专用数据库并保留原账。

## 重要信息

- 原 task 为 task-4c4780a541c5ea7c51024975de5f121d；原 execution 为 bdb7b510-4a09-4cd3-9a06-8ac8dda42608。
