# 钉钉授权回复实时生效验收报告

## 结论

全部 10 项验收通过。钉钉本人会话中的非空引用回复可实时关联对应人工介入事项；回复不需要包含“批准”或“拒绝”。明确拒绝语义映射为内部 `rejected`，其余非空处理意见映射为内部 `approved`，完整原文进入原 Task 后再由任务核验执行范围。

## 证据层

- 自动化：`pnpm test` 151 项全部通过；关键审批用例连续 20 轮通过。
- 产物：提交包包含 adapter/bridge 修复文件，解包哈希与源码一致。
- 运行态：本地 Runtime `status=ok`、`recoveryIssueCount=0`，群和个人 listener 均为 `ready`。
- 业务 E2E：独立测试常驻会话创建可控删除 Task；无批准/拒绝关键词的真实钉钉引用回复使申请进入 `answered/approved` 且来源为 `dingtalk`，Task 恢复并完成，测试文件经独立回读确认不存在，群完成通知已真实投递。

详细证据见 `round-1.md`，状态以 `matrix.csv` 为准。
