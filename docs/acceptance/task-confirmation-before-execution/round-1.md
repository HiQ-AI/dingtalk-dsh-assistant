# Round 1

## 当前结论

现场根因、代码修复、自动化测试和本地部署均已收敛。

## 现场证据

- 21:10:57、21:12:02、21:13:20、21:14:53 的前三轮有效尝试均包含任务确认，但依次被回复替换完整性、pending Steer 和候选快照门禁拒绝。
- 21:17:52 的最终提交保留同一个 `task-reopen`，把 `reply` 改为空字符串后被接受，4 条请求标记为 delivered，Task 第 2 轮随即启动；Outbox 没有对应确认。
- 源码协议允许“涉及任务时 reply 可为空”，验证只在非空回复时执行；提交路径先执行 Task 动作、后写 Outbox。三处共同导致现场结果。

## 实现证据

- Task 动作空回复返回结构化 `reply-required`，请求保持 pending，Task 与 Outbox 均为零；同一请求补全回复后可正常提交。
- Outbox listener 快照证明新 Task 尚未创建；已有 Task 的重开和上下文更新也都发生在 Outbox 事件之后。
- Outbox 写入失败时新 Task 数量保持为零；动作完成后 Outbox 能原子补齐实际 Task ID。
- 快速取消回归证明叶子取消信号在 Task 串行队列释放前触发，迟到结果被拒绝。

## 自动化结果

- `node --test test/runtime.test.js test/store.test.js`：89/89 通过。
- `npm test`：186/186 通过。
- `git diff --check`：通过；仅有仓库既有的 Windows 行尾提示。

## 本地部署结果

- 从提交 `95e3958` 打包根包、`@zzusp/dingtalk-dsh-assistant` 和 `@zzusp/dingtalk-dsh-observer`，安装到 `C:\Users\64554\.dsh\profiles\web`。
- 安装后的 `runtime.js`、`store.js` 和 observer `web-client.js` 与源码 SHA-256 均一致。
- `@zzusp/dsh-compaction-convergent` 保持 `0.1.1-rc.2-convergent.6`。
- 重启后主进程 PID 69184 同时监听 `127.0.0.1:3080` 和 `127.0.0.1:18998`，Web 返回 HTTP 200。
- `/health` 返回 `status=ok`、`transport=dws`、`inboundProcessing=true`、`recoveryIssueCount=0`。
- DWS 群 listener 与个人回复 listener 均为 `ready`，backfill 为 `ok`；最近消息 647—658 均为 `delivered`，没有 pending 或 `decision-commit-failed`。
- 群仍绑定原 Resident Session：`session-group-00fb7328cc47085feddbf03e-87f62c1b`。

## 未冒充的验证边界

- 本轮没有向真实群发送专用测试消息，也没有追补历史确认；真实钉钉新消息 E2E 留给下一条自然群消息验证，避免在业务群制造额外噪声。
