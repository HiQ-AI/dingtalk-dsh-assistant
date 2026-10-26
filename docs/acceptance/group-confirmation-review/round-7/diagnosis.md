# 原生空返回恢复用例的阶段等待修正

结论：本次对照没有发现新增执行、重复写入、遗漏唤醒或恢复不前进。原用例把五秒退避、恢复读原执行、两名成员核验和最后统筹收口合计限制在十五秒，混合了不同验证阶段。仅将测试改为分阶段等待，产品代码未修改；没有提高外层三十秒总时限。对照样本不足以证明性能等价，也没有据此声明产品延迟问题已解决。

## 最小因果证据

此前失败 `round-6-empty-recovery.stdout.log` 显示：`humanRequests=[]`、`humanReviewLease=null`，并未进入新增群答复复核路径；统筹已到第四轮，三个执行均成功、工具错误为空，失败发生在最后收口前的十五秒轮询期限。

使用 Node 24 的 `registerHooks` 对照，仅在 baseline 模式把六个本轮修改的产品模块替换为 `git HEAD` 内容；保留同一测试、原生 fixture、依赖 profile、临时目录及原十五秒断言。实现和观测配方为本目录 `recovery-diagnostic-hook.mjs`，没有修改源码文件来切换基线。

| 原等待条件下的运行 | 整例耗时 | 开始轮询至完成 | 结果 | 原生事件 |
| --- | --- | --- | --- | --- |
| HEAD 基线 | 15.240 秒 | 9.126 秒 | PASS | `baseline-72628.jsonl` |
| 候选 | 20.276 秒 | 12.338 秒 | PASS | `candidate-43664.jsonl` |
| HEAD 基线再观察（已在主会话停止扩大验证前启动） | 26.333 秒 | 14.414 秒 | PASS | `baseline-13888.jsonl` |

三次均为四轮统筹；调用计数完全一致：`model_content_read=143`、`execution_submit=3`、`execution_team_read=2`、`group_topic_summary_submit=1`、`pwsh=1`、`read=1`、`task_delegate=3`、`task_execution_read=1`、`task_session_submit=3`。首个基线与候选的退避后重新认领分别发生于轮询开始后 5.001 秒和 4.991 秒；相同基线自身的后续完成耗时也有明显波动。不能从一次候选超时推定新增逻辑导致恢复故障。

## 精确修正

`test/task-session-service-native.test.js` 只修改该例：先在十秒内确认受控模型已在原统筹恢复轮读取恢复提示并进入原执行审阅，再调用既有 `service.whenIdle()` 等待运行中的原生调度链排空，显式断言任务完成。保留外层三十秒总时限和全部“只写一次、三执行、原 executionId/inputVersion、唯一完成事件、回执绑定、重复 recover 不重放”等断言。

## 修正后最终实跑

直接运行候选，不使用诊断 hook：

```powershell
$env:DSH_NATIVE_TEST_PROFILE='D:/dsh_home/profiles/web/package.json'
$env:TEMP=(Resolve-Path docs/acceptance/group-confirmation-review/round-7/runtime).Path
$env:TMP=$env:TEMP
node --test --test-name-pattern 'empty owner recovery reviews' test/task-session-service-native.test.js
```

`candidate-fixed.log`：1 PASS、0 FAIL、0 SKIP，整例 24.222 秒，进程 25.666 秒；原外层三十秒时限内完成，写一次和审计断言全部通过。`git diff --check` 无错误。未重跑其他已通过文件，未改产品逻辑，未操作真实任务数据或发送消息。
