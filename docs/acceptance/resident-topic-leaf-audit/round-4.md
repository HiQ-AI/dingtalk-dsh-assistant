# Round 4：Topic 固定版本工具修复与真实回归

## 根因与修复

- 真实 DSH 工具框架在 render 前递归校验输出是否为无损 JSON；Topic 上下文含有可选 `undefined` 字段时被拒绝。
- `projectTopicContext` 在对外边界完成 JSON 归一化，确保顶层和消息附件等嵌套字段均不含 `undefined`。
- 新增摘要缺失、消息可选字段和附件嵌套可选字段的回归断言。

## 自动验证

- `node --test test/topic-runtime.test.js`：28/28 PASS。
- `pnpm test`：237/237 PASS。
- `node docs/acceptance/resident-topic-leaf-audit/scripts/probe.mjs`：10/10 PASS。
- `git diff --check`：通过。

## 重新部署

- 修复提交：`d1d035eaba62f37307bd7ba6374ae44f7b455b99`。
- Assistant 与 Observer `0.5.13` 打包至 `%USERPROFILE%/.dsh/artifacts/dingtalk-dsh-assistant/d1d035e/` 并以精确文件依赖安装到 Web profile。
- 新进程 PID `1060828` 同时监听 `127.0.0.1:3080` 与 `127.0.0.1:18998`。
- `/health` 返回 `status=ok`、`transport=dws`、`recoveryIssueCount=0`。

## 真实 E2E

测试标识：`resident-topic-tool-e2e-20260907-2332`。

1. DWS 发送带真实 @ 的只读任务，原消息 ID 为 `msgGSWpLXIFmhR1izuxjJWGAA==`。
2. Resident 成功调用 `group_topic_context_get` 读取 Topic `topic-2bfb9ddeeaad059a46c1dd0fbab54be8` 的 revision 2，并从固定版本中取得测试标识。
3. Runtime 创建叶子 Task `task-8246ec166ff59f7f42f5497854075074`；叶子再次成功读取 revision 2，完成 2 个 checkpoint 后转为 completed。
4. 完成 Outbox `outbound-4c490e58-ff8f-4253-ae5e-8c5619e93363` 状态为 sent，回复原消息，真实消息 ID 为 `msgONugnUNGsh9sKLZuv19t6w==`。
5. DWS 搜索回读原消息、更正确认和最终结果共 3 条：`complete=true`、`enrichedCount=3`、`failedCount=0`、`hasMore=false`；两条回复均引用原消息。

固定 Topic 工具、Task 和渠道回复链路已闭环。
