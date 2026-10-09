# Round 76：现场 Owner 读取事实与同回合纠正

## 现场根因

SG22 原持久 Owner turn14 seq7785/7787 已实际读取 efb12…、6b20… 两 SHA 产物。turn15 换为 workflowRevision，却因跨 turn readArtifacts Map 清空被拒；补读后相同候选又触发重复保护。另上一轮仅 repairCurrentStage 缺 workflowRevision 先 accepted，再走不适用的领域输入恢复失败。

## 修复与验证

- 原生 user/message 快照核 Task/session/requirementRevision，call/result 配对核实际成功读取及完整分页覆盖。只返回 immutable SHA refs；controller 与当前需求/阶段引用取交集，核逻辑 Task 并重新读工件。失败回执、其他任务、旧需求和缺页不复用；不新增账或缓存。
- 相同候选在新增成功读取覆盖后可继续；重读同一正文、重叠区间或越过正文末尾不会增加进度。
- workflow-revision 模式缺 workflowRevision 在工具入口明确提示 startNodeId 与 Host 能力，同回合修正，不先接纳。

原生两轮及重新创建 session 管理器测试通过：第二轮不重读旧 failure/prepare，仍沿原 Task/Run 成功，成功前缀不重做。原生工具参数纠正/重复保护反例通过。

实际 SG22 JSONL seq<8300（turn15前）只读验证，新解析器恢复23个完整 SHA 阅读，efb12/6b20均确实包含；不输出私密正文，未修改现场。该证据证明已读事实可恢复，不等同部署后业务完成。

```powershell
$env:TEMP=(Resolve-Path docs/tmp/clarification-tests).Path
$env:TMP=$env:TEMP
node --test test/task-owner-store.test.js test/task-owner-recovery.test.js test/task-owner-session-native.test.js
node --test --test-name-pattern='Owner经真实service' test/workflow-service.test.js
```

- docs/tmp/owner-round76-final.log：105/105 PASS，24495.5 ms。
- docs/tmp/owner-round76-service.log：3/3 PASS，15895.9 ms。实际 service/contracts/registry/controller 链路，合法引用应用、跨 Task/旧计划拒绝。
- 两日志独立回读；git diff --check通过。
- 模型为确定性 session/原生工具 fixture，真实云模型另有round72。本轮没有部署、现场写账、提交或发群消息；现场任务继续与业务验收待新包实际回读。
