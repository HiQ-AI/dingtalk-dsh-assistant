# Round 30：协调器零事项消息遗留输入屏障

现场只读确认：`msg-092d3c5ab9e8f636fd7771ff2d63b6738eb83b66` 与 `msg-f6c29262127904c25e7b22d6b6d45ea95a5540da` 均为已消费、settled、只有 barrier/impact 而无 unit/command 的消息；其 pending barrier 分别绑定撤回通知排查 Task 与数据集开发 Task 的来源。另两个 pending unit 均属于 superseded 版本，不是阻塞来源。

根因是 coordinator.commit 零事项直接标记 settled，但 dispatch 清屏障要求至少一个 unit，恢复协调器又仅对有 command 的消息 dispatch。Owner 的输入准入仍正确拒绝未解除的 barrier，因此保持 pending，不曾调用模型。不是模型过载或会话占用。

修复复用协调器结算路径：零事项提交事务内核验当前来源、消费事实、无有效 unit/待处理 request/非终态 command 或 agent execution，解除该 run 拥有的 barrier。历史恢复提供只读 `message.barrier.no-action` 摘要查询及内部 `message.barrier.reconcile-no-action` 命令；同事务重核条件和全快照摘要，随后调用已有 onBarrierResolved。禁止过期来源、待处理事项及其它 run 所有的屏障被清理。不新增 Task/回复、不改业务授权、不重放原文。

验证（真实 execution.store worker，TEMP/TMP 位于 D 盘）：

```powershell
node --test test/message-workflow.test.js
node --test --test-name-pattern='零事项协调提交|旧局部判断失败改由协调' test/message-ledger.test.js
```

结果分别 10/10、2/2 PASS。覆盖新提交零事项原子清屏障、历史扫描恢复及幂等、重启读取、无 Task handler 调用、未消费拒绝、摘要漂移拒绝、来源新版本拒绝、pending request/command/unit 保持屏障。私有现场只读，未在现场执行恢复、部署或发消息。README 与本地部署规程同步零事项屏障恢复边界。

复核收紧：历史恢复仅接受已 settled 的来源，pending 即使标记 processed 也拒绝；若协调器正在重新处理该来源，同样拒绝。新消息仅在 coordinator.commit 自身零事项提交事务内结清。已添加 pending-run 反例并重跑通过。

追加即时唤醒验证：coordinator 将本轮 turnId 传给既有 dispatch，dispatch 仅回调该轮实际解除的零事项屏障；普通重扫和其它轮不回调，不派发业务命令。message-workflow 11/11 PASS、ledger 定向2/2 PASS。
最终回归：coordinator 50/50、message-workflow 11/11、ledger 定向2/2 PASS。首次coordinator运行49/50，旧反例揭示跨任务source_edit屏障必须保留；修复为零事项结算排除source_edit，其本源编辑结算仍由既有严格分支负责。现场3个遗留fence均无reason字段，只读复核确认不受排除影响。
