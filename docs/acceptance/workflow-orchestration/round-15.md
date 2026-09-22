# 第 15 轮：部署候选全量验证

- `pnpm test`：612/612 通过，0 失败、0 取消、0 跳过，62.76 秒。原始输出：[full-tests.txt](round-15/full-tests.txt)。
- 首步骤前路由抢占也自动排队续行，原生 Inbox 消息保留；whenSettled 不会提前触发失败重试。
- 状态问答仍严格禁止 Task 动作，既有越界反例通过。
- `node scripts/build-web-client.mjs` 后生成文件无语义差异；`git diff --check` 通过。
- 真实 v9 存储只读预检：ok=true、invalidRecords=0、strippedFields=0、unknownTables=0；部署前无活动 Task。

用户已授权本地打包部署；安装摘要、进程和运行态将在部署记录单独补充。此处不宣称真实群耗时已达标或真实消息已送达。
