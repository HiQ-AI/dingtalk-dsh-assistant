# PR #335 本地部署与只读验收

## 版本与切换

PR https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/335 已合并，部署源码冻结于 `f9b1b38d60f0202aced9e0f96f2b202b0acf6aab`。本轮为合并源码的本地 2.3.0 双包，不是 npm/tag 发布。官方宿主仍为 0.2.1-rc.2，未修改；未主动运行 CI。

按 `docs/ops/task-session-clean-start.md` 运行既有原生双包脚本：先 Check，writes=0/signals=0，任务/执行/群均已排空；旧 PID 8976 经原生 SIGINT 退出，捕获的子进程全部退出、双端口关闭后离线核对并安装。保留 3 笔 unknown 操作，不重放、不改账；不备份历史副本。新 PID **35984** 同时监听 3080/18998；独立检查旧进程不存在、计划任务启用、health=ok、DWS healthy、inboundProcessing=true、recoveryIssueCount=0。

- Assistant SHA256：`85b476c13c8cd69b39cd7f8996baa945c6d574a471b3f16c0e28236fd766e6a2`。
- Observer SHA256：`ad7f6b7efd5fa775fd4a578553d376df4bd3e28a1c3a29c9ae503ee10f1eb074`。
- profile patch SHA256 保持 `1f2c3b27f47d2635c5c02c22c5965ec6c1d12b3516c86d77de7a8a4813e59f55`。
- 安装包保留于 `D:/dsh_home/packages/by-sha256/<sha>/package.tgz`；独立摘要/版本/健康证据见 `round-5/independent-readback.json`，原生阶段收据见 `round-5/deployment/`。

## 实跑结果

1. `DSH_NATIVE_TEST_PROFILE` 指向本检出的 `test/fixtures/native-profile/package.json`，System32 的原生 tar 优先，执行 `pnpm test:release-smoke`：**14 tests / 14 pass / 0 fail / 0 skipped**。首次误传目录得到 12 pass/2 skip，不作为完整通过；修正参数后原样重跑，无断言或 timeout 改动。
2. 先运行 `scripts/measure-native-browser.py --check`，再通过实际 Chrome 和当前启动日志认证进入真实宿主：看板首开 177.38 ms，六栏目各两轮、实际任务详情及 decisions/executions JSON 终态均 PASS。插件请求最慢 248.08 ms；页面/请求错误 0，业务写入 0。新浏览器 context 不等于进程冷启动；宿主 session/list 单独观察终态，不混入插件指标。首次在进程尚未输出登录链接时，浏览器前置检查失败；等待同一新进程就绪后检查通过，无重启。
3. `node docs/acceptance/observer-first-load/scripts/measure-live-tail.mjs docs/acceptance/observer-first-load/round-5/http-after.json 60`：60.593 秒、508 次真实只读 GET，四类接口各 127 次，全部 200 且 JSON 解析成功；话题详情来自现场真实目录，不保存其身份或正文。

| 接口 | 次数 | P50 ms | P95 ms | 最大 ms | ≥1s 次数 |
| --- | --- | --- | --- | --- | --- |
| `/health` | 127 | 18.82 | 976.52 | 2199.30 | 6 |
| `/state/groups?summary=true` | 127 | 19.63 | 976.58 | 2199.60 | 6 |
| `/state/tasks?offset=0&limit=50` | 127 | 47.07 | 1005.88 | 2246.09 | 7 |
| `/state/topics/:id?groupId=:id` | 127 | 43.07 | 1007.21 | 2225.82 | 7 |

## 结论与边界

部署、健康、真实页面与只读功能验证通过；**不能声称长尾已完全消除**。本轮没有 ≥3 秒请求，但仍观察到约 2.2 秒共同停顿，四接口合计 26 次 ≥1 秒。修复前 round-4 在 CPU 采样同期记录 134 请求、最大 5590 ms、6 次 ≥3 秒；本轮无 CPU 采样且请求组成、次数、进程不同，不能计算严格同比加速比例，也不能推定原 HAR 的相同时间窗口必然消失。此前索引/解析修复的因果证据仍以 round-4 的基线失败与隔离对照为准。

官方宿主冷加载与 session/list 明确不改；JSON 持久化等剩余贡献尚未完整归因。本轮不为验证发群消息、重试通知、改任务或恢复未知操作，故不声称真实钉钉写入业务验收通过。用户授权的合并、部署和上述验证已完成；进一步削减残余长尾属于后续修复。

最终保留本轮报告、JSON 证据及复用脚本；本轮临时打包副本与测试日志在结果摘要落盘后清理，持久安装包保留。旧 round-1/round-3 与 topic-page-latency 本地资料属于既有工作，不清理或混入提交。

旧轮原始明细清理：browser-final.json与http-after.json已在round-7完成最终证据归档和核对后删除；本报告的原轮次结果与摘要保留，当前现场结论以round-7.md为准。
