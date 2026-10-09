# Round 74：Owner 经实际 service / contracts 修订工程任务

## 结果

3/3 PASS，16215.9 ms。仅新增 test/workflow-service.test.js 定向用例；未改生产源码、未部署或写现场。

实际链路：真实 Git fixture 与工程 registry 创建 v19 冻结工作流 → 原生 store/controller 到 plan-local-acceptance 等待 → openWorkflowService 内创建的 Owner controller 实际读取原需求、当前阶段产物与 system.recovery 工件 → task-workflow-contracts 第二证据门禁 → 工程 registry 生成持久任务副本 → controller 同 Run/generation 应用。

- current：决定 applicationStatus=applied，workflowDigest 实际改变，原 Owner sessionId 保持；已成功 define 节点 outputRef 与 lease 保持；原待办规划进入第二次实际执行。
- foreign：跨 Task 失败诊断在 Owner 门禁拒绝，workflowDigest 与执行次数不变。
- old-plan：旧 planRevision 诊断同样拒绝，无修订或执行重放。

Owner/执行模型使用确定性 session fixture，未伪装真实云模型；消息来源目录是外部边界 fixture。没有替换 repairCurrentStage 回调、没有直接绕过 contracts 调 controller 作为修复入口。外部消息权限不由本例证明。范围只验证修订实际应用，后续规划仍由 fixture 等待，不声称业务整体完成。真实云模型另见 round 72。

```powershell
$env:TEMP=(Resolve-Path docs/tmp/clarification-tests).Path
$env:TMP=$env:TEMP
node --test --test-name-pattern='Owner经真实service' test/workflow-service.test.js
```

最终日志：docs/tmp/owner-service-round74-final.log，已独立回读。git diff --check 通过。

初次fixture漏loopback/port参数导致 LOCAL_ACCEPTANCE_CONFIG_INVALID，日志保留 owner-service-round74-initial.log；随后补齐冻结配置的真实前置（UAT分支、原需求绑定及只读来源scope）。这不是业务实现失败，未添加生产兜底。
