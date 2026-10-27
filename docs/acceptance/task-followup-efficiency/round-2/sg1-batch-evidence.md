# 多来源事实追问复核

独立审查发现首轮单来源验证未覆盖积压场景：`task_session_submit` 一次只回复一个来源，而原服务回合结束会传入全部已领取 `wakeIds`。如果同轮有两条事实追问，直接 ack 全部会吞掉尚未答复的来源。该反例成立，首轮结论不涵盖多来源完整性。

修订落在既有 `wake.ack` 的存储边界：本轮有事实答复时，根据当前请求的 `followupReplies` 只 ack 所含来源已经全部答复的唤醒；含剩余来源的唤醒保持待处理并返回 `remainingWakeIds`。下一原会话回合复用 `pendingTaskHumanReview` 排除已答来源。既支持一个 wake 含多个来源，也支持多个 wake；随后对无关来源提交普通 wait 时照常消费，不产生空转。没有新增等待机制或模型参数。

验证结果：

- `node --test --test-name-pattern='多来源事实追问|待答事实追问' test/dynamic-task-store.test.js`：3/3，通过，见 `followup-batch-store.log`。
- 原生 profile `D:/dsh_home/profiles/web/package.json`，`node --test --test-concurrency=1 --test-name-pattern='积压的两条事实追问|待实施批准期间' test/task-session-human-native.test.js`：3/3，通过，零跳过，12.640 秒，见 `followup-batch-native.log`。
- 最终 `node --test test/dynamic-task-store.test.js`：121/121，通过，零跳过，10.434 秒，见 `followup-store-full.log`。
- `git diff --check`：通过；主线程测试映射文件仅有 Git 行尾提示。

两种原生积压场景都先保存两条事实追问及一条无关消息，再恢复原生调度。断言每轮候选从三条变两条再变一条；两条事实回复均通过发送和独立回读进入 `delivered`，分别引用并提及各自不同作者；第三条只记录判断，恢复扫描不重跑；原问题仍待答，执行/操作数量为零。原生模型与通知传输使用确定性测试适配器，不代表真实钉钉发送或线上模型识别准确率。

本轮仅修改 `dynamic-task-store.js`、两份既有相关测试、人工介入 API 文档和本证据记录。后续最终原生整合回归由主线程统一执行，本成员不重复启动。
