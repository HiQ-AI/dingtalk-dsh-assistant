# Round 28：有效业务补充后的 resume 控制冲突

## 现场结论

`msg-5f6f9fb6b3f07281e8bb3893c5ac46dd04c8319d` 并非模型过载或协调器占用：消息于 07:25:09.138Z 被 lease 83 消费；fact 命令于 07:25:09.377Z applied；resume 于 07:25:09.413Z unknown，错误 `TASK_CONTROL_CONFLICT`。随后群协调器 lease 84 于 07:25:13.562Z idle，error/retryAt 均空。

只读控制库回查原 Task `task-5c4b495243ce147b3d6e32279fe9715f`：control_state 为 active，control_revision 为 1；原 resume 对应 `task-control:<commandId>` receipt 不存在，`intent:<commandId>` 事件也不存在。因此不是已成功恢复而丢失回执；业务等待被错送进了“人工暂停恢复”控制命令。`execution-task-plan.js` 的 task.control.resume 仅允许 paused，限制本身正确。

旧 `message-workflow.js` dispatch 排除 unknown，普通恢复扫描不会自行重做；因此已消费消息仍 pending，并可继续形成消息输入屏障。没有重放来源或直接修改现场库。

## 修复范围

- `workflow-service.js` Task action：active、非 succeeded/cancelled 的 resume 通过既有 `intent.received` 事件唤醒原 Owner，记录真实来源/actor/arguments，不改 controlRevision；paused 仍走原控制路径。取消和完成状态不得通过该分支恢复。
- `message-ledger.js` 新增内部 `message.command.recover-business-resume`：仅接受 unknown/resume/TASK_CONTROL_CONFLICT。事务内检查命令摘要、当前来源版本、原 Task 同群与来源人/Host Owner 权限、Task active 且非终态、control/requirement/Owner revision、无控制 receipt；同事务登记 Owner intent 事件并将原命令标记 applied、结算 unit/run。不调用外部工具，不新增 Task，不删除原命令。
- 恢复扫描只处理以上精确类别，使用现有 artifacts 固化来源与检查证据。来源或版本漂移拒绝；有控制 receipt 不擅自认领。扫描位于 `Promise.allSettled` 独立通路，单命令错误收集，不阻塞其它恢复通路。
- 为复用 Owner 原生事件事务，ledger 引用 `reduceTaskOwnerCommand`；存在 ESM 函数循环依赖，真实 worker 加载与集成测试已通过。未新增桥接抽象；主代理将追加 ledger 全文件验证。

## 本轮实跑

PowerShell 将 TEMP/TMP 指向工作树 `docs/tmp/authorization-state-tests`，执行：

```powershell
node --test --test-name-pattern='业务等待的有效补充resume|任务直接调查慢回合' test/workflow-service.test.js
```

结果：3/3 PASS。覆盖正常业务等待继续（Owner 第二轮、控制版本不变、零执行实例）、paused 原控制路径及真实 receipt、cancelled 保持拒绝、历史 unknown 恢复、来源/control/Owner/摘要漂移拒绝、paused/cancelled/succeeded 历史账拒绝、已有控制 receipt 拒绝。历史 unknown fixture 仅构造于临时测试库；恢复通过真实 execution.store 事务完成。

`git diff --check` 对修改的 service、ledger 和测试文件通过。此轮仅代码及测试证据；未部署、未恢复现场 Task，也不宣称现场屏障已解除。

追加 `node --test test/message-ledger.test.js`：132/132 PASS，166.41秒。验证完整消息账和真实模块加载未受新增恢复分支影响。
