# 第 2 轮：部署后实际工具装配失败

源码 a72000a 的安装包 SHA256 为 fb30544f0e5ceb2a5a48f31bd5d7d911f1b3c44e3841a257089fe96a4850de70。正式部署 Check 零写入通过；新进程 3900 双端口及健康回读通过，维护退出并恢复派发。部署证据保存在本地 docs/tmp/owner-native-deploy-20261013，不提交运行主体及敏感配置。

原 Task 通过正式 reassess 接回同一持久 Owner，事件已接纳且进入新轮次；但独立检查真实 request/header，工具列表仍只有登记查询和任务控制，没有 pwsh/read/write/skill。原会话如实报告工具未挂载，native.recorded 数量为 0。本轮自主业务验证 FAIL，未取得完成或群回复证据。

根因与反证：SDK 的 agents.create/resume 不自动挂载 agent preset；Owner 只设置自有 setup。既有常驻会话实现显式调用 agentPresets.mount，Owner 遗漏了此步骤。另 tools.get(name) 查询全局层，preset 工具需要传 agent 作用域。因此前轮全局工具夹具不能代表真实 preset 装配，必须补挂载和作用域测试。不是用户缺业务信息，也不是需要维护方代做业务测试。

继续在同一 PR 修正装配并重新部署；不改原 Task、不删除历史失败或创建替代业务任务。

补充修复：原生模式的 Owner 不再使用 complete 提示覆盖，以保留原生执行说明与 preset 的提示节；工作区指引仍由 preset 原生机制加载。真实 standing-scope AgentLoop 测试证明全局不可见工具在挂载后可调用，禁止的 subagent 不进入模型工具 schema；第二次恢复沿用已保存 preset 且仅记录一次选择。最终 `node --test test/task-owner-session-native.test.js` 为 63/63 PASS，另 `git diff --check` 通过。测试不替代下一轮实际部署验证。
