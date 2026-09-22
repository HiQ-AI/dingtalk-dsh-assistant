# 第 4 轮：许可门禁与确定性负载对比

日期：2026-09-22。此次仅做本地测试，未发送真实消息、迁移真实 profile 或调用真实模型。

## 命令与结果

```powershell
node --test test/task-permits.test.js test/report-native-lifecycle.test.js test/task-reports.test.js
node --test --test-name-pattern='任务并发容量满|报告先持久接收|系统等待恢复先' test/runtime.test.js
node docs/acceptance/workflow-orchestration/scripts/replay-coordination-load.mjs | Set-Content docs/acceptance/workflow-orchestration/round-4/queue-replay.json
```

前两条分别通过 24/24、3/3。原生生命周期测试使用真实 AgentLoop、Inbox、Goal 服务与 fake LLM，证明协调结果消息不能绕过无许可门禁，A 释放后 B 先执行，A 必须重新取得许可。纯许可测试覆盖排空前仍占容量、重复请求、缩容、取消排队以及迟到释放不能删除新许可。Runtime 三项筛选覆盖原有 FIFO 取消释放、持久报告停等和系统失败只读恢复；完整 Runtime 回归另轮记录。

## 负载配方与可复现性

脚本从 Git 基线 `83fc504596f0faff4c65f92991a444ea13f6af5a` 读取旧版真实 `coordination-sessions.js` 和其 step gate，与当前工作区真实模块比较。模型句柄是可控替身，每次服务固定一个虚拟 tick；一 tick 等于 10 虚拟毫秒，不是实际网络耗时。两群独立运行，入站窗口 96 ticks；1× 为 route 每 2 ticks、review 每 8 ticks，0.5×/2× 同比调整到达间隔。

每种负载各重复三轮，共 18 次队列回放；同版本三轮派发轨迹摘要一致。每次自动断言全部请求最终派发、无调度异常、每群峰值并发为 1，新策略在已有 review 排队时连续 route 不超过 2 次。原始结果和当前模块 SHA-256 位于 [queue-replay.json](round-4/queue-replay.json)。

| 负载 | 请求数 | 旧 review 等待 P95 | 新 review 等待 P95 | 旧 route 等待 P95 | 新 route 等待 P95 | 旧/新全体等待 P95 | 旧/新总模拟时长 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.5× | 60 | 0 | 0 | 0 | 0 | 0 / 0 | 950 / 950 |
| 1× | 120 | 0 | 0 | 0 | 0 | 0 / 0 | 970 / 970 |
| 2× | 239 | 920 | 0 | 0 | 240 | 790 / 240 | 1210 / 1210 |

表内时间单位均为虚拟毫秒。2× 下旧策略在 review 已排队时最多连续启动 95 次 route，新策略为 1 次；两群各自峰值并发均为 1。

## 结论与边界

- 本配方中高负载公平性改善，代价是将部分 route 的等待转移给入站分类；总模拟时长没有改善，不能据此声称吞吐增加。
- 低负载两策略相同；此处零等待由固定服务时长和特定到达序列产生，不代表线上 review 零延迟。
- 未测真实 provider token、模型时延、网络抖动、DWS 发送或附件；不能由此推论真实成本或渠道延迟收益。
- 有限事件流最终排空不证明持续过载可无限承载；该测试也不能代替业务来源、版本、授权和取消门禁测试。
- 许可实现等实际 `whenIdle` 后释放。单纯报告工具返回不代表旧叶子的工具调用已落稳。
