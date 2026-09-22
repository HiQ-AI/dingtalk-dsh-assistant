# 第 6 轮：全量集成反例

`pnpm test`：510 项，508 PASS、2 FAIL；原输出见 `round-6-tests.log`。

- descriptor 源码断言仍按旧的 5 个 permission 安装点计数，新协调会话增加第 6 个；实际权限边界另由原生 ToolRuntime guard 测试覆盖。
- 人工阻塞后的完成审阅恢复测试在新协调会话送达前使用旧句柄。改为等待新请求实际 owner；保留旧句柄禁止提交的反例，不放宽生产校验。

本轮未宣称全量通过。
