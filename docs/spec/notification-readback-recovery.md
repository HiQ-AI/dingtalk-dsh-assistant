# Goal 回执与通知回读修复

目标：先通过现有 operator 对账入口结清原 Goal 失败回执、恢复原任务，再修复九条通知正文匹配；不得重发，验证后部署。

现状：原 create_goal 明确返回 GOAL_TOOL_AUTHORITY_REQUIRED，同回合正常结束且绑定只读调查已完成。现有 human reply/check 已能验证该证据，正式入口结为 failed 并保留 previousObservation，无需增加对账分支。原任务同一 session 已恢复。

通知的 SUCCESS 发送回执、消息身份、会话、发送者、引用均吻合；不匹配集中在顶层无序列表相邻条目之间的单换行或空行被 DWS 消除。现有匹配仅处理连续编号列表。排除消息未发送、身份错配和正文内容变更；不采用删除所有空白的宽泛匹配。

实现：扩展现有 listRendered，只折叠围栏外同一连续顶层 `- ` 列表的条目间换行，保留项目内容、顺序、标记、段落边界和英文空格。沿现有 unknown 只回读路径对账。

验证：合成正文正反例、精确回执身份拒绝、unknown 不调用 send、九条真实回读离线验证。部署前等待活动执行排空，核对包摘要、新进程与健康；部署后独立查询九条 delivered、消息身份及 sendAttemptCount 不变。

关联发现：人工结清复合事务只返回 task，operationCache 未刷新，账本 failed 但 Web 告警仍 unknown。修复 command 包装器对该事务按原 operationId 独立回读缓存，不更改账本语义。原生 operator exact error resolution 用例新增告警消除断言；已复现旧代码 true !== false，修复代码 PASS。测试模型必须正确响应当前 Topic 决策/摘要调用，不能将它们当执行步骤递增。
