# 第 4 轮：预算、引用恢复与最终审查回接

日期：2026-11-03

## 结论与源码边界

本轮保留 D 独立审查发现的三个实际失败、A 修复后 D 的手动回接结果，以及 core 在改动中的共享树上执行的定向测试。没有覆盖 round-1 至 round-3 的历史结果；round-2 的固定版本摘要 FAIL 未复测，仍保留。该轮不代表最终冻结源码验收。

执行基线仍为 `worktree-topic-routing-quality`、HEAD `c80d42bf747cb950aa03ab7906194123bfc5683a` 加未提交团队改动。D 的新增预算/引用/幽灵路由检查使用临时 Bash heredoc 内存 harness，没有落盘脚本、断言库或源码 hash；core 的测试也未捕获执行时 diff/hash。故 `PASS*` 只表示成员按当时输出人工核对或测试命令报告通过，不证明 HEAD 本身或最终集成 SHA 通过。

## D 内存 harness：失败与修复回接

公共 harness 入口为 `node --input-type=module <<'JS' ... JS`，在内存 `DomainFacility` backend 上打开 `openResidentStore` 并建立 `createTopicCoordinator`，由 agent `steer` 收集路由请求；没有付费模型、真实钉钉或正式数据。PASS/FAIL 来自 D 对输出的人工核对，不是新增自动化断言。

### 长转义消息预算

修复前，45,000 个双引号构成长文本进入无 Topic/候选的首包时，D 观察到 `envelopeChars=79279`、`budget=40000`、`visibleText=39305`、`textHasMore=true`，超过包预算。

A 增加 JSON 安全二分/候选分页后，D 用同类输入回接，输出：

```json
{"case":"escaped-fixed","chars":39999,"text":19665,"more":true,"errors":[]}
```

D 判定包长不超过 40,000、正文可续读且无错误，为人工回接 PASS。D 未循环读完 remainder；A 自己新增的预算测试另行报告，不能将 D 的这项输出描述成完读联测。其后仍有 45,000 字符的 `quotedMessage.content` 冻结/续读需求待 A 实现、D 审查，本项不证明该能力已完成。

### 引用晚到共同恢复与部分提交拒绝

修复前，original 已 deferred、answer 先入账后富化加入引用时，original 仍为 `needs-context` 且没有 `routingRecoveryMessageId`，被 D 报告为 FAIL。

A 修复后，D 在内存 store 中依次 deferred original、入账 answer、以同一 answer v2 富化 `quotedMessage:{messageId:'original',content:'original'}`，再尝试只提交 answer 的 partial route。输出：

```json
{"messages":[{"messageId":"original","messageVersion":1,"routingStatus":"pending","routingRecoveryMessageId":"answer"},{"messageId":"answer","messageVersion":2,"routingStatus":"pending"}],"partialRejected":"topic_routing_recovery_incomplete"}
```

D 人工核对共同恢复配对成立且部分提交被拒绝，记 PASS*。没有保存完整 heredoc，不应声称此项是固定命令或自动化断言。

### 元数据错误后的幽灵路由清理

失败场景：消息首次携带 45,000 字符 quoted content，路由准备返回 `topic_route_context_metadata_too_large`；同一 messageId 富化为 v2、短 quote 后再次 schedule，发送仍为 0，只有原错误，D 报告旧 route 状态残留。

A 清理准备阶段失败的 routes 对象后，D 同样用内存 harness 回接，完整输出：

```json
{"firstSent":0,"afterCorrectionSent":1,"dispatchedVersion":2,"errors":["topic_route_context_metadata_too_large"]}
```

D 判定修正后仅发送一次 v2、无幽灵请求，记 PASS*。保留错误历史是预期可见诊断。此结果不证明 45,000 字符合法 quote 可以完整读取；冻结 quote 续读由 A 继续实现，D 将另审。

### Scope 外独立推进

D 另以共享内存协调器验证 B 草稿先因 hold 返回 `routing-required`，hold scope 收窄到 A 后，schedule/drain 使 B processed=1 且 decision completed，而 A 保持未处理、hold 仍为 `needs-context`，errors=[]。D 判定 scope 外事项可独立推进，记 PASS*。该检查为内存 harness 人工核对，无持久测试脚本/hash。

## Core 候选复验

routing-core 报告以下命令在改动中的共享树执行：

```powershell
node --test test/topic-runtime.test.js test/group-decision-contract.test.js test/coordination-sessions.test.js
node --test --test-name-pattern='引用元数据晚到|路由审计理由变更' test/topic-store.test.js
node --test --test-name-pattern='路由首包按 JSON|大澄清候选' test/topic-runtime.test.js
node --test test/coordination-native-lifecycle.test.js
```

结果依次为 201/201、2/2、2/2、6/6。第一组覆盖路由/决策、协调 session；第二组为 quote 富化与理由重放；第三组为路由首包 JSON 预算和大澄清候选；末组只验证原生角色 guard，不在该 AgentLoop 中执行候选分页，不能合称 native 分页联测通过。core 未记录这些执行时的 HEAD/diff/hash，须在冻结源码版本上重新绑定。

另有隔离 profile 失败证据，不能隐去：

```powershell
$env:DSH_NATIVE_TEST_PROFILE = (Resolve-Path 'test/fixtures/native-profile/package.json').Path
node --test --test-name-pattern="native request-bound review and Topic reads" test/task-topic-routing-native.test.js
```

Lead 报告 0 pass、1 fail、0 skip，原 30,000ms business 超时（prepare 794ms、cleanup 124ms），日志宿主名 `b71fucey0.output`。新 active 审计要求 reason，而该既有自定义 native fixture 尚未适配；B 负责逐例适配必要既有测试，需同原阈值复验确认根因与结果。本轮不将原因当作已确认修复，也不提高 timeout 或删断言掩盖失败。

## 独立审查范围

D 报告对 A 的审查覆盖来源完整性与 version/epoch、候选审计理由/schema 指纹、scope 与 Topic 联合接纳、引用共同恢复、旧 route receipt / accepted ledger 不重判、applied operation 跳过、候选分页连续 offset 与澄清完读约束、锁内候选指纹；对 B 覆盖 loopback/Host/Origin 本地身份、resume/scope 二选一及完整范围确认/CAS、本群 Topic 校验、needs-context 防旧完成戳覆盖、分页 hold 修订与 UI 不冒充完成；额外验证 scope=A 时旧 B 草稿重新核验一次通过。

通知实现由 D 独占 `dynamic-task-store.js` / `task-session-service.js`，D 不审自己代码，该部分由 A 审查。B 对 HTTP/UI 的审查未报告可证实缺陷，但 B 测试未重跑、C 由 B 审。D 无剩余已知审查阻断，但 A 的长 quote 冻结/续读尚待实现及独立审查，因此不能将整体审查称为冻结完成。

D 未执行真实生产实例、真实模型或钉钉外发；D 的审查回接使用内存 harness，不是 nativeTaskHost。README/round-3 中 B 的隔离浏览器使用 HTTP mock，不等于真实服务验收。

## 未完成

- A 完成长 quote 冻结与续读后，D 独立回接，并在最终源码冻结时绑定 hash 实跑预算、引用富化、ghost-route 清理和路由首包测试。
- B 适配 `test/task-topic-routing-native.test.js` 的既有自定义 fixture 后，以原 30 秒阈值复验；本轮 0/1 FAIL 保留。
- round-2 固定版本摘要 FAIL 仍未复测；真实模型、部署、生产和钉钉外发未执行。
- C 的评估 CLI/provider 尚未稳定；新增测试文件稳定后才运行测试映射 update、审阅完整 diff，再 check。本轮未运行映射命令。
- 仅在以上相关阻断完成、工作树冻结并实跑后，才能给出最终集成验收结论；round-1 至 round-4 的失败历史均保留。

矩阵 `PASS*` 表示成员报告的命令通过或 D 对真实输出人工核对，且没有精确源码 hash；它们不是最终 SHA 验收。
