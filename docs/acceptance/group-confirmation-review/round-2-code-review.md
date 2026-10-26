# 第 2 轮群答复复核代码审查

范围：当前工作树的 `dynamic-task-store.js`、`task-session-service.js`、`task-session.js`、`model-context.js` 及对应 `dynamic-task-store`、`task-session-human-native` 测试增量。只读源码、测试与有关合同；没有修改实现、运行测试/构建、连接外部服务或验证在线实例。报告按委派要求写入本验收目录。

## 发现

### [P2] 复核把工具错误上限误转为空返回自动重试（初审发现；已修正，见末尾复审）

位置：`packages/dingtalk-dsh-assistant/task-session-service.js:1120-1123`，新增的 `if (humanReview) throw ... TASK_SESSION_NO_SUBMISSION`。

这一分支不区分 `runResult.reason`，因此将已明确的工具错误上限覆盖成“模型没有提交决定”。原生会话包装器在工具执行连续出错时递增 `technicalFailures`，第三次设置 `entry.halted = error.code`（`task-session.js:167-174`）；退出时明确返回 `{status: 'no_submission', reason: entry.halted}`（第 248–260 行）。新增分支丢掉该 reason，随后第 1132–1133 行把它记为 `task.provider-failure`，安排自动重试。

可复现条件（源码推导，审查者未执行）：

1. 创建 requester 待答问题，接纳有效群来源并领取 humanReview。
2. 在复核中连续三次调用 `task_human_resolve`，传一个不存在于本轮候选集的 `sourceId`。存储会稳定抛 `DYNAMIC_HUMAN_REVIEW_SOURCE_INVALID`（`dynamic-task-store.js:870-871`）。
3. 包装器到达工具错误上限，返回带真实 reason 的 no_submission；服务却改记为 `TASK_SESSION_NO_SUBMISSION`，把协议/工具错误送入模型重试预算。

实际风险：真实诊断丢失，系统反复重试同类无效决策，最终耗尽恢复预算；用户和维护者看到的是空返回而非实际来源校验错误。这不是未经授权写入的发现。`README.md:335` 明确“真实配置错误和工具错误上限不进入此路径”，故不是预期退避政策。

可接受修订边界：

- 真正正常结束却没有提交决定，以及可识别的暂时 provider 故障，保留原 wake 并沿既有持久预算重试。
- 显式工具错误上限保留原 reason，不能伪装为 provider/空返回；无新增模型自动重试，不清空或重置既有累计预算。
- 未解除时保留原问题、候选和来源审计；若 resolve 已成功，不回滚或重放成功解除。无论哪种结果都不能在同轮开放执行权限。
- 复审需检查实际修订及一条到达工具错误上限的定向测试。现有“禁止工具被 guard 拒绝后继续有效 resolve”测试不等于该场景：guard 拒绝不走注册工具执行包装器的三次错误计数。

此发现已告知主执行和实现者 `group_wait_resolution`，本审查未改动任何源码。

## 已排除的疑点与已核对边界

| 范围 | 已读代码结论 |
| --- | --- |
| 当前问题/租约/版本 | `pendingTaskHumanReview` 要求当前 requester 问题及 requirement/control 版本；resolve 再检查当前 binding、所领取 wake、requestId、sourceId 和来源归属/时间。`currentTask` 另核对 contextRevision。 |
| 真实作者与业务角色 | 保存不可变来源中的 actorId，模型输入保留实际作者、原文和版本；业务角色充分性由统筹判断。这是 API 文档明确的语义职责，不应误报为缺少“仅原发起人可答”的硬编码。 |
| 复核写拦截 | 原生 tool guard 限制为读取/复核/wait；服务 callbacks 和存储 `humanReviewLease` 对委派、反馈、取消、操作对账、完成等再拦截。 |
| resolve 后同轮 | resolve 未清除 humanReviewLease；input.humanReview 和 callbacks 也不变。新 `human.responded` 不在本轮领取的 wakeIds 内，正常执行只能在下一租约进入。 |
| wake 与重启 | 只领取当前复核候选 wake，普通执行/创建 wake 保留；只有成功提交才 ack；未提交和暂错候选保留。存储重启恢复原租约记录，后续领取增大 lease。所读测试包含 crash、provider-failure 和 resolve-before-drain。 |
| 已运行执行及 feedback | preserve 不 cancelLiveTask；待答期暂不向原执行注入未经复核摘要，既有 execution、会话和已记录 feedback 没有删除/改写。解除后的正常统筹可按原 executionId 投递经判断的 feedback。新测试核对原运行身份，但未直接断言一条先前未消费 feedback 经复核后仍能正确消费，不能宣称该端到端场景本轮已实证。 |
| 退避上限 | 初步怀疑“七次后新 preserve 消息不能重启模型”，经 `README.md:335` 和既有合同反证后撤回：暂停自动重试、重启不重置预算是预期保护，不能要求新群答复自动绕过技术错误上限。 |

上表是代码审查判断，不是当前测试执行结果。除上述 P2 外，在本次已审范围内暂未发现新的确定安全绕过；不据此宣称所有来源变体、原执行回路或在线群聊已验收。

## 审查候选身份

基线 HEAD：`917a4a038fba6c8a3df771cfed470051d7fc151d`。本轮审查的是未提交增量，以下 SHA256 固定发现时的实际文件；修正后另记录复审身份。

| 文件 | SHA256 |
| --- | --- |
| `packages/dingtalk-dsh-assistant/dynamic-task-store.js` | `8558D40941BFD14DCC4DC01B5490E5B46F35130C6DD41B67918C1FC9F88B0C87` |
| `packages/dingtalk-dsh-assistant/task-session-service.js` | `09CE64FCD107905CD93183DB54E2FC4A2922194383168C3DB9395F612800A6A1` |
| `packages/dingtalk-dsh-assistant/task-session.js` | `3B285B5137A77D89D316327CA975089CA6A736BC37D7C3D72B36282A666EC919` |
| `packages/dingtalk-dsh-assistant/model-context.js` | `42B68827C9E3872C810E9BAED174D57EBB7402C6DC29199026678BF3CDDCD503` |
| `test/dynamic-task-store.test.js` | `731310E73879AD2CA384A0FFCB5EAB77FACB9B13CDC33EE004F9A2F2E48C1999` |
| `test/task-session-human-native.test.js` | `D9AC565D0BD8CEDF3EF87632DAC4FB4A1D5F7BC36AE04BE581EDC5BE6A96F7AA` |

## 修正后复审结论

本项 P2 在源码层已关闭；在本次修订及其受影响路径内，未发现新的确定问题。原发现及候选身份保留在上文，不覆盖初审证据。复审只阅读了已冻结的实际 diff 和测试定义，没有亲自运行测试；存储、原生宿主及整组定向运行结果由实现者和主执行记录，不能把本结论当成在线群聊验收。

- `task-session-service.js:1120-1129` 现在只把没有 reason 的 no_submission 转入既有空返回恢复；有 reason 的工具错误按原错误码写入失败决定，`submitted = !humanReview` 保证不 ack 失败候选。
- `dynamic-task-store.js:810-823` 将真实错误码、来源、候选 wake、租约和记录时间保存到原申请的 `reviewFailures`；第 853 行对这条路径保留既有 `providerRecovery`，没有重置此前 provider 预算。
- `dynamic-task-store.js:26-38` 根据失败记录的候选 wakeIds 判断是否有新的合格候选。普通 contextRevision 变化、无新增来源的摘要、旧消息或 Web 来源不能单独再次驱动同一失败候选。问题与候选记录保持，真实新来源仍经既有门禁处理；既有 provider 冷却/上限继续有效。
- 原 resolve 成功记录和 humanReviewLease 不会被失败分支回滚或放开；同轮只读和下一正常轮消费 human.responded 的边界未变。
- 已读测试定义新增 `none/empty/tool-limit` 三分支，其中 tool-limit 实际调用无效候选来源直到原生包装器到达错误上限，断言保存 `DYNAMIC_HUMAN_REVIEW_SOURCE_INVALID`、不产生 providerRecovery、不在 recover 后自动重试；存储测试另断言重启保留失败/wake、非合格来源不激活及既有 attempts 不变。它们能针对原发现形成反例检查，不只匹配提示关键词；是否执行通过仍以对应原始运行结果为准。

复审读取的修正文件 SHA256：

| 文件 | SHA256 |
| --- | --- |
| `packages/dingtalk-dsh-assistant/dynamic-task-store.js` | `07CA0FFB3810641D954DB200484E6D14E1D3246A8514680D5DF30CFB334E29E1` |
| `packages/dingtalk-dsh-assistant/task-session-service.js` | `19AFE91B1F7DF6221F4521361C2186B07CD130F04FC9E78435AED2B55D17C703` |
| `test/dynamic-task-store.test.js` | `C536358AB3724B56FC295AA0FFBCACDEFDE9617A38E203D4993BFF7FD865428A` |
| `test/task-session-human-native.test.js` | `57EAB9363E281DED0B480DD13363DD60A78F593E70C775DA623B90363E9A3955` |
