# 第一轮：实现与边界验证

2026-10-21。完整保留失败，未将其计为最终通过。

- 初次账本/原生测试：19 pass、2 fail、1 cancelled。新断言把不存在 executionId 的 `not found` 当作身份错配，把未出现的 feedback 字段当成空数组；更改为真实其他执行的身份错配和按既有合同读取缺省字段。首次 Host 用例超过 30 秒预算，双轮 Host 测试调整为 60 秒。见 `round-1/initial-tests.log`。
- 修正后同组 22/22 通过，held/none、同会话续办、参数拒绝、零操作/零额外反馈均验证。见 `round-1/resource-rerun.log`。
- 既有回归首次 120/122 通过。绝对临时路径使上下文预算用例超过约束，按其说明用进程级 TEMP/TMP 指向已有物理短路径。恢复用例在未启动执行前失败；未修改基线单独运行也复现相同错误，见 `round-1/baseline-progress.log`。夹具只设置 Agent provider，统筹配置仍选默认脚本 provider；只给该测试补相同的 config.provider，不改产品模型选择。见 `round-1/regression.log`。
- 同名替换反例初次尝试被原生注册接口更早拒绝（`tool "execution_resources_read" is already registered in this scope`），因此没有触发预期的后置 guard 字符串。修正断言为原生接口拒绝替换、零替代副作用、原 Host 查询仍执行；不修改原生能力或删除产品 guard。
- 会话回读中途失效及缺少 Host 回调两例独立通过。最终候选加入同名注册反例后统一重跑，见下一轮。

以上均为隔离测试/环境修正，不是线上故障，也未将平台部署失败纳入产品优化范围。
