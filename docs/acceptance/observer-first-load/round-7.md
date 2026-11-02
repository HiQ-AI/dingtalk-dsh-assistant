# 群身份修复合并部署与现场复验

## 部署事实

PR https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/336 已合并，部署基于 `c80d42bf747cb950aa03ab7906194123bfc5683a`。普通本机 2.3.0 双包更新，不是 npm/tag 发布，无 schema 或数据迁移，不修改官方宿主（仍0.2.1-rc.2），未主动运行CI。

按 `docs/ops/task-session-clean-start.md` 原生双包流程：Check writes=0/signals=0，Task/Execution/Group 均静止，3 unknown操作保留；原生SIGINT退出精确旧PID35984，捕获子进程全部退出、双端口关闭并离线核账后安装。新PID **29252** 同时监听3080/18998。独立回读包摘要、安装2.3.0版本、实际task-session-service.js与合并源码SHA一致、旧进程不存在、health=ok、DWS healthy、入站开启、恢复问题0、自启启用。profile摘要保持不变，不备份历史副本、不清库、不重放消息或未知效果。

- Assistant SHA256：`faf1d05f364af010e61642caa596db92e2343fbf7a4f1792b03dbed0c308b826`。
- Observer SHA256：`ad7f6b7efd5fa775fd4a578553d376df4bd3e28a1c3a29c9ae503ee10f1eb074`。
- 持久安装包在 `D:/dsh_home/packages/by-sha256/<sha>/package.tgz`；完整回读见 round-7/independent-readback.json，阶段收据见 round-7/deployment/。

## 实跑

- 原生依赖 `DSH_NATIVE_TEST_PROFILE=<本检出>/test/fixtures/native-profile/package.json`，Windows System32 的 tar 优先，`pnpm test:release-smoke`：14tests/14pass/0fail/0skip。此前round-6的11+23项源码风险回归已完成，本轮产品源码未另改，不重复累计或重跑。
- 浏览器脚本先 `--check`，再通过实际Chrome和启动日志认证，只读打开看板、六栏目各两轮、任务详情及decisions/executions JSON终态：PASS，页面/请求错误0，业务写0。首开看板644.37ms；栏目约234.88–1235.58ms，最慢为第一轮人工介入；插件单请求最大929.12ms。新context不等于进程冷启动，官方session/list单独等待终态，不混计插件指标。
- `node docs/acceptance/observer-first-load/scripts/measure-live-tail.mjs docs/acceptance/observer-first-load/round-7/http-after.json 60`：61.058秒、548次并发只读GET，全部200且JSON成功，无请求错误和业务写入。

| 接口 | 次数 | P50 ms | P95 ms | 最大 ms | ≥1s 次数 |
| --- | --- | --- | --- | --- | --- |
| `/health` | 137 | 7.59 | 921.29 | 2619.20 | 6 |
| `/state/groups?summary=true` | 137 | 9.50 | 921.58 | 2619.14 | 6 |
| `/state/tasks?offset=0&limit=50` | 137 | 46.45 | 952.39 | 2641.41 | 6 |
| `/state/topics/:id?groupId=:id` | 137 | 39.50 | 954.45 | 2638.21 | 6 |

## 结论与真实遗留

合并、部署、安装回读和功能复验完成；**仍有约2.64秒共同长尾，本轮不能证明端到端长尾改善**。无≥3秒请求，但24次≥1秒。上一轮round-5同脚本最大2246.09ms，本轮最大2641.41ms；进程及现场负载不同，不能据一轮样本判定回归或提速，更不能把局部101000→0过滤次数当线上延迟收益。已安装此次身份修复这一事实由包/源码摘要绑定，具体消除无谓遍历的因果证据仍是round-6的基线失败与候选通过。

未完整归因的JSON序列化、文件检查和其他后台查询仍保留为后续问题；本轮不扩大为额外实施，不改官方宿主。没有发送测试群消息、重试通知或手动改账，故不声称真实钉钉写入业务验证完成。

## 产物保留

当前最终浏览器和持续HTTP证据集中于round-7/。round-5的browser-final.json与http-after.json为旧轮重复原始明细，已由本轮终态证据替代并清理；其原结果、关键指标、版本和结论仍完整保留在round-5.md。round-6 CPU和基线回归摘要仍作为修复因果证据保留。临时打包副本和冒烟日志在摘要核对后清理，持久安装包保留，其他会话及旧本地资料不动。
