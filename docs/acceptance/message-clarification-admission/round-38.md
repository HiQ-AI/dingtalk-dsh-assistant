# Round 38：首次查询前能力阻塞的原任务重评

## 根因与现场只读证据

`task-5c4b495243ce147b3d6e32279fe9715f` 正式 reassess 返回 `TASK_OWNER_REASSESS_FORBIDDEN`。逐条件查询确认唯一不满足项为“当前需求/授权/输入版本存在已处理 query.succeeded”。当前 Task req2、plan0、control1/active；Owner rev14、lease3、idle、auth1、inputFence5，无 currentTurn。已有查询 seq328/329 属于 lease2、req1、auth1、inputFence2；最新 lease3 在首次查询前提交 capability block。无当前完成结论、活跃回合、execution run/node/input/effect 或外部 stage。

因此不是 capability identity 改变 authorization revision；实际是需求修订后旧查询不再属于当前版本，而当前版本先被能力缺口阻塞，形成“必须先成功查询才能重评”的循环。

## 最小修改

只修改 `execution-store-worker.js` 既有 `task.owner.reassess` 谓词：当前 lease、requirement、plan、control、authorization、input fence 全匹配且 accepted/applied 的 wait/block，condition.kind 为 capability、permission 或 execution，并且没有任何 Task effect 时，不再要求已有成功查询。

仍沿用原接口、来源原文/身份校验、Owner及Task CAS、零活跃回合、已完成禁止、外部阶段/效果限制和幂等回执；business-input、approval、旧版本不能借此继续。该操作只唤醒原 Owner 重新评估，不改变需求，不创建执行阶段，不授予生产执行或其他写权限。

## 验证

```powershell
node --test --test-name-pattern='未查询能力阻塞沿原Task受管重评|工程准备未落计划的Owner受管重评' test/execution-store.test.js
```

真实 execution.store worker：21/21 PASS（新增7例，既有工程准备重评14例）。新增用例均经原生 requirement.update 将 req1 更新到 req2，再提交未查询 wait/block；capability/permission/execution 可重评，结果 pending、需求仍req2、零execution run、重放幂等。business-input/approval/旧版本/已有effect拒绝。`git diff --check` 通过。

本轮未提交、部署、写现场账或恢复现场任务。首次测试因测试 fixture 的 requirement.update 缺必填 eventKey 失败，补齐真实命令合同后完成上述全绿验证；生产逻辑未为测试放宽。
