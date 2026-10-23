# 第三轮：最终有效验收

## 本地合同与服务链路

以下为本轮实际执行的定向测试；统计按不同用例计171项，不累计修复重跑次数。原生测试使用 `DSH_NATIVE_TEST_PROFILE=test/fixtures/native-profile/package.json` 的绝对路径。

| node --test 后的文件（均在 test/） | 结果 |
| --- | --- |
| coordination-schedule-revisions.test.js | 21/21 |
| coordination-conditional-query.test.js | 4/4 |
| coordination-summary.test.js coordination-trigger-commands.test.js | 27/27 |
| task-operator-notification-scan.test.js task-message-projections.test.js task-notification-delivery.test.js task-notification-readback.test.js | 60/60 |
| independent-coordination-recovery.test.js | 35/35 |
| independent-coordination-changes-native.test.js | 7/7 |
| independent-coordination-native.test.js | 17/17 |

这些命令均 exit0、0 fail、0 skip。恢复门禁最后修订后，额外用 `--test-name-pattern='两条原始提醒'` 复跑核心原生链路，1/1通过，不重复累计。两条完整原话相隔39秒，验证同一 coordination、来源结清、没有 Task/Topic、15:20前不执行、到期经真实 service/job.remind 冻结正文并投递一次；重复恢复不重发。模型为受控夹具，不能代替下面真实语义验证。

最终接纳正文断言为“已安排提醒：2026-10-23 15:20（Asia/Shanghai），提醒你查看云端专家的开发进度。”；不采用模型 interpretation 中的内部推理。`node scripts/test-suites.mjs check` 通过，301文件各一次、历史3文件、删除0；逐项比较只改变通知扫描测试的 native 分类与77项轮转 lane，文件全集与 release 集合不变。

通知测试用 deferred gate 保持第二条规划未完成，第一条 prepared 已实际走隔离发送器并回读；发送槽释放后下一条无需额外 recover/whenIdle 继续。unknown 不重发/忙轮询，限流仍阻止后续发送。同值投影100次持久 update 增量0，真实状态变化增量1。实际 sendStartedAt 跨重启保留，旧记录不以 createdAt 伪造。

## 真实模型语义

生产独立 planner + 原生 Host + 真实已安装 time-context，`openai-codex / gpt-6-astra / low`；只开放两个协调工具，submit 捕获提案，不创建真实计划或外发。三轮 planner SHA256 一致：`0547fe67a7f78a36c5aeefdfc9bb5232c0e568d7f85afc6e1d951a2a8d1dba27`。

首轮六例与第三轮第七例组成7个有效情境，逐条核对实际提案：

1. 原例第二条读取原安排后 resolve 为当天15:20纯提醒，无 Task，无额外确认。
2. 明确未来提醒直接 schedule，无任务详情读取。
3. 明确委托代查保持 read-query。
4. 显式纽约时间覆盖 Host 工作时区，UTC换算正确。
5. 原消息发出前已过的时刻只问必要的新时间，不默改明天。
6. “另外”且对象不同创建独立提醒，不误补全原事项。
7. 已有提醒读取真实 id 后 schedule-change 原计划，不另建。

7例有效结果共9个模型回复，单例4.893–14.974秒，中位7.687秒。该数值只覆盖隔离 planner，不能推算线上端到端改善。原生请求仍真实包含缺浏览器时区提示，未删改上游提示或伪造 browser source。前两轮第7例无效结果保留，见相应 model-results.json；[第三轮最终改期结果](round-3/model-results.json)使用生产 id/conversationId 合同。

## 可重复入口

```powershell
$env:DSH_NATIVE_TEST_PROFILE = '<已安装原生 profile 的 package.json 绝对路径>'
node docs/acceptance/reminder-message-correction/scripts/evaluate-model.mjs <新的docs/tmp目录> <已安装Connect入口绝对路径> gpt-6-astra low <现用代理URL> [case-id]
```

省略 case-id 跑7例；只重跑改期传 `accepted-reminder-changes-original`。输出目录必须不存在，避免覆盖失败证据。使用现有获授权模型通道；不挂真实业务发送器。预期及案例名称不进入模型输入。新增薄入口的原因是现有 JSON 模型回放没有真实时间插件，不能复现缺浏览器时区冲突；底层 Host、planner、比较器和日志读取均复用现有实现。

尚未安装本地候选包、未触发 CI、未执行真实钉钉提醒或线上耗时对比；本轮只证明代码合同与模型语义。
