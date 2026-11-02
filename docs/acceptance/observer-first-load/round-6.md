# 群身份查询误用展示投影

## 当前现场与根因

运行实例为 PR #335 的合并源码 f9b1b38d、PID 35984；round-5 一分钟只读验证最大仍有 2246.09ms 共同长尾。本轮未改安装代码、未部署候选。

以已有 `docs/acceptance/topic-page-latency/scripts/profile-resident.mjs 35984 30 --check` 先检查，再去掉 `--check` 采样。31.947秒 CPU 中 groupView→getGroup→ingest→DWS 入站调用链 inclusive 1902ms，占约6%；这不是单次请求耗时，也不能与重叠栈相加。采样完成后独立 HTTP 检查9229无法连接，脚本打开的 inspector 已关闭；提取的脱敏栈见 round-6/cpu-before.json。

真实调用链：DWS `processMessage` → `service.ingest` → `legacy.getGroup`（只用布尔存在性）→ `task-resident-runtime.groupView` → `messages.filter(isOwnNotification)`。每次新消息、补拉或身份查询都会为一个群记录展开整群历史并逐条执行通知身份判断，结果却只拿来检查订阅存在。服务另有职责配置、Web、重试和 isGroup 六处同因读取。

比较三个候选：网络不解释明确同步 CPU 栈；JSON serialize 与 HMR stat 的成本存在但不是这条链，且官方宿主不在范围内；群身份误用展示可独立重现且能在现有权威 store 修复。本轮只修第三项，不把其他热点猜成同根因。

## 修复与边界

七处内部读取统一使用已有 `residentStore.getGroup`，身份与职责均来自同一权威群记录。没有新增查询接口、缓存、兼容路径或降级。入站认证、订阅拒绝、通知精确身份及未知效果保护不变；展示仍走原 facade，按当前身份过滤，不缓存旧视图。取消订阅后下一次检查即时失效。README 同步说明读取边界。

## 实跑

原生依赖参数 `DSH_NATIVE_TEST_PROFILE` 指向本检出的 `test/fixtures/native-profile/package.json`。源码与测试 SHA256、精确计数见 round-6/validation-summary.json。

- 新增测试使用真实 nativeTaskHost、真实 openTaskResidentRuntime facade 与1000条合成历史（只在展示 facade 注入，不污染权威业务数据）。100次 isGroup + 一次未认证入站，在旧源码得到 **101000次历史过滤，断言期望0，0pass/1fail**；修改后同一用例 **1pass/0fail**、历史过滤0。
- 该用例同时验证缺群/缺身份仍拒绝、删除群后身份即时失效、展示通知身份变化立即反映、0模型调用。首次夹具缺少 agentDefaultModel 时的 TypeError 不是缺陷重现；补齐原生 fixture 已有 getAgentConfig 后才采集上述有效基线。
- `node --test --test-concurrency=1 test/task-session-reply-identity.test.js test/task-session-clean-start.test.js`：**11pass / 0fail / 0skip**。
- `node --test --test-concurrency=1 --test-name-pattern='群身份|own|echo|epoch|ingress|source|web|routing|notification|周期恢复' test/task-session-service-native.test.js`：**23pass / 0fail / 0skip**，含新增用例，不再重复累计单独1项。
- `node --check packages/dingtalk-dsh-assistant/task-session-service.js`、`git diff --check`、唯一 goal 结构校验通过。最终验证前 fetch，origin/main 仍为 f9b1b38d，无需额外整合。

## 结论

确认并消除接入/身份校验不必要的全群历史展示遍历；不声称线上约2.2秒长尾已消除，候选未合并部署。序列化、文件检查和其他后台查询仍有成本，尚未完整归因。未主动运行CI或触发真实消息/通知重试。

沿用 round-5 已部署基线证据（尚未被本轮候选现场复验替代）；本轮仅保留 CPU 汇总、验证摘要与本报告，临时日志在摘要核对后清理。已有历史本地资料不清理。
