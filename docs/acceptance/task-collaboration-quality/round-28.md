# R28：原生团队通信与身份复验

真实整队第二次仍为 FAIL，未提交或部署。两位队友确已生成：`calc`、`check`，team `session-af2e0bb3`；CLI UUID `74ccd3a5-6cf0-41bc-a01e-e349a01ce313`。`Agent PostToolUse` 与 `SubagentStart` 并发登记问题已通过该路径，并补入自动测试。

实际双方通过原生 SendMessage 交叉核算 37×19=703。但 calc 向 `team-lead` 的多条发送虽然返回 success/msg_id，Lead 原生上下文没有对应入站材料；check 用 `to=main` 的消息以 `attachment.origin.kind=peer/from=check` 进入了 Lead 上下文。Lead 正确保持未完成并反复等待 calc，不将发件回执当实收。

修复采用 Claude 原生主会话地址 `main`：受管队友的普通报告使用 main，成员互信使用名字；不新增自制消息中继。`team-lead` 只保留原生关闭协议用途。

本轮在收尾发生另一个 `SubagentStop/member_unbound`，尚待精确诊断，不能将第二轮记为团队成功。wrapper 81968 和 CLI 71672 已独立回读不存在；原始证据保留 `docs/tmp/interactive-team-live-2/`，其中 `result.json` 记录加载时源码摘要和失败，不覆盖。

发布包验证：12 项通用 smoke 通过，最初未指定完整 native profile 的 2 项跳过；指定现场 native profile 后实际包用例 1 项通过、1 项 30 秒超时。保留 `round-27/release-smoke.log`、`round-27/package-native-smoke.log`，将在最终固定包上按原限时复验，不修改限时掩盖失败。

adapter R28 的新增反例包括队友登记 race、错误身份、成员再派生、按 actor 独立读取反馈、未准入伪结果、PowerShell 后台效果及主会话地址。中间夹具错误及修正日志分别保留 `round-28/adapter-tests-*.log`；最终状态以 matrix 后续记录为准。
