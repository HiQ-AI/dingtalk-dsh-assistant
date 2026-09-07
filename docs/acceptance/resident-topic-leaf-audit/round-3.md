# Round 3：本地部署与真实 DWS E2E

## 部署结果

- 基于提交 `3f21f906bcc6706ea21e860c0429ed5637044b61` 打包 Assistant 与 Observer `0.5.13`。
- tgz 存放于 `%USERPROFILE%/.dsh/artifacts/dingtalk-dsh-assistant/3f21f90/`，Web profile 的两个依赖均指向该唯一目录。
- 安装目录源码回读包含 `task_explicit_authorization_required`、waiting 只统计 running 以及 `messageWorkflowState`。
- 完整重启后 3080、18998 由同一新进程监听；`/state/version` 返回 `0.5.13`。
- `/health` 返回 `status=ok`、`transport=dws`、真实模型、入站处理中、允许出站、恢复问题 0。
- DWS 群 listener、个人回复 listener 均为 ready，backfill 为 ok 且 bridge healthy。

## 最小 E2E

测试标识：`resident-hardening-e2e-20260907-2257`。

1. 使用 DWS 向唯一已订阅测试群发送明确指向 Agent 的只读任务。
2. DWS 搜索回读原始消息：1 条命中、完整、无失败。
3. Runtime 将消息归类并建立 Task `task-5c8b173dab84ac5cf99ad6fd579466a0`，先发送引用确认。
4. 叶子只读检查 Runtime 版本、健康接口和监听端口，4 个 checkpoint 完成后 Task 转为 completed。
5. Runtime 发送引用原消息的完成通知；DWS 再次搜索回读原消息和最终回复共 2 条，`complete=true`、`hasMore=false`、`failedCount=0`。

最终回复确认 Runtime `0.5.13`、health HTTP 200、DWS bridge healthy、恢复问题 0。

## 观察项

叶子两次调用 `group_topic_context_get` 时收到 `invalid output: value is not lossless JSON`。本次任务信封已包含唯一完整输入，因此没有影响 Task 或回复闭环；该工具问题需要另行定位，不能视为本轮机制已验证通过的部分。
