# Round 1：根因取证与原生回归

2026-10-20。基线为 origin/main `760b2a0d4506b2ca6d36c9c604c6cd5a49c00224`，隔离分支 `worktree-completed-task-followup`。主检出的已有变更未参与修改。

## 当时实际读取了什么

原生路由会话只查了 12 条 PR 相关话题，然后把消息归为跨事项的新话题。原生决策会话确实调用 `group_task_list(limit=100)`，目录完整结果共 14 项，全部 completed；从未调用任务详情、补读 spill 或尝试 task-reopen。

目录原始回执 177519 字节，模型可见结果明确标注省略 94607 字节。原始回执 SHA256 为 `13ee39bfeea428792d8911525dfe6916ad7e9b2cd0a783dd8296ef283571ac03`。决定文本把“集中核查、不重做已完成任务、沿原 PR 续作”写入新 Task，而原协议早已支持批量 action 和 task-reopen。安装内容与最新源码一致。

因此排除“完全没有读取已完成任务”和“重开接口不可用”。主要问题是任务身份选择语义缺失，目录过大是额外的可见性缺陷，不能将它说成唯一根因。原生会话标识及行号见 [前置分析](../../spec/completed-task-followup.md)。

## 修改与测试

- 明确旧交付的核查、修订、重新提测沿原 Task，由原 Owner 先核验条件；批量事项可在一个 Topic 中提交多个 task-reopen；新 Topic 不推导新 Task。
- 任务目录仅返回身份、版本、话题及目标/完成摘要，单页上限 12 KiB。nextOffset 由实际返回数计算，避免字节预算提前结束时漏项；详情工具仍保留完整内容。
- `DSH_NATIVE_TEST_PROFILE` 指向本机已安装的完整 Web profile，`pnpm install --frozen-lockfile` 完成。
- `node --test test/task-topic-routing-native.test.js`：6 pass，0 fail，0 skipped，10314.7241 ms。包含 14 项长正文目录完整翻页；两个 completed 原任务重开，Task ID/sessionId/来源/原话题保留；无关任务不变；重复消息不重复执行。模型为确定性适配器，Task 服务、工具、会话和持久账本为真实实现。
- `node --test test/topic-runtime.test.js test/coordination-sessions.test.js test/task-web-topic-reuse-native.test.js`：130 pass，0 fail，0 skipped，7292.8608 ms。覆盖独立新任务、归档限制、版本冲突、授权、单一 effectOwner、重试和原话题复用。

## 未通过的模型回放

首轮隔离真实模型回放未产生决策：验证脚本按旧 profile 结构读取 provider 设置，遗漏实际 `cordis.patch.yml` 中的代理，得到 `TRANSPORT / fetch failed`。只停止本轮精确匹配的独立验证进程；没有操作业务进程或现场任务。

修正脚本为读取当前 profile 中唯一的 `dsh-codex-connect` 配置，保留代理，YAML 的 JS 标签只作为字符串读取；不执行配置表达式、不打印凭据。下一轮重新运行零写 check 后回放。此失败记录保留，不能由定向测试通过替代真实模型验证。
