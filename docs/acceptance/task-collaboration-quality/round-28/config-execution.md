# R28 独立 adapter 修复复验

本轮职责：保留 R27 的 31 个用例，增加真实 Team 启动并发身份绑定、成员反馈隔离与拒绝未准入工具结果的测试。仅修改既有测试文件与必要版本说明，不修改后端，不操作真实用户 CLI 或部署。

R28 首次执行 40 项：37 PASS / 3 FAIL / 0 skipped，日志 adapter-tests-1.log。新增 Agent Post/SubagentStart race、原生 Team 结果身份、成员再派生拒绝，以及 Lead 读取反馈不能授权成员写文件已通过。失败原因是测试夹具仍等待旧 cli 日志结构，以及把成员 feedbackReceipt 覆盖 Lead 的 receipt；已按当前 hook.result 与每 actor receipt 契约更新，不删除断言。

新增第 41 项：PreToolUse 拒绝后伪造 Agent Post 必须拒绝，不能注册队友。等待后端 call.admitted 修复后完整复验。配置说明最低版本同步当前代码门禁 >=2.1.295。

第二次完整执行：45/45 PASS、0 skipped、0 cancelled，48.9 秒自然退出 0（adapter-tests-2.log）。覆盖原 31 用例及新增原生队友 race、格式/身份、准入、嵌套、反馈隔离、重复成员与 PowerShell 后台回执反例。对应 PreToolUse 未准入则拒绝 Post，成员独立读取反馈后才允许其真实文件写入。

真实 live2 新发现普通队员报告使用 team-lead 别名未进入 Lead 上下文，后端新增 main 收件人要求后，再补第 46 项：普通报告 team-lead 拒绝、main 允许，但原生 shutdown_response 到 team-lead 仍允许。第三次完整复验记录独立保留 adapter-tests-3.log。

第三次完整复验最终：46/46 PASS、0 skipped、0 cancelled，56.2 秒，测试宿主自然退出 0。独立回读日志尾部及源码 SHA，证据 config-final-proof.json。原有测试全保留；本文件仅提供管道适配的受管子进程和真实 HTTP hooks/MCP 证据，真实 PTY/Claude 与部署由主验证链承担。R28 测试职责冻结。
