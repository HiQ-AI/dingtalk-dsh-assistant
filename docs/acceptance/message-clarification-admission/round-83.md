# Round 83：Owner 收回执行修复与运行时改图

用户最新要求取代此前 Owner 修复/动态流程设计：只推进 SG20；工程故障由原执行会话纠正；恢复保留成功节点。当前轮不操作现场，其他任务停止由主线程处理。

## 实现

- Owner 原生 schema 删除 repairCurrentStage、repair、workflowRevision；当前回合提示明确执行责任归原执行会话。
- controller 与 Store 拒绝新修复决定；同需求已建立计划禁止动态追加/重排。初始业务计划、按既有计划 advance 和显式需求更新保留。
- 原 currentExecution 诊断可读，但不再公开可修复绑定/动态改图能力。
- 历史 pending/blocked 修复不调用旧动作，保存原决定、完整诊断、计划、回执和效果后封存；已 applied 保持，不回滚成功效果。

## 验证

`docs/tmp/owner-withdraw-final3.log`：14/14 PASS，1818.476 ms。实际原生 Owner schema/提交、原生 Store/controller 历史 pending/blocked/applied 三态、当前候选禁止改图、既有 advance、业务等待与完成证据门禁均覆盖。旧 Owner 改图测试改为明确拒绝，不跳过。

首次隔离 fixture 缺 authorizeStages，随后缺 historical workflow 登记，两次失败日志保留 `owner-withdraw-policy.log` / `owner-withdraw-policy2.log`。修复测试配置后 `owner-withdraw-policy3.log` 4/4 PASS。仅关闭本轮明确识别的挂起测试进程，未触碰现场进程。

原生查询/历史阅读帮助函数和持久图恢复格式保留。其他旧 Owner 修复专用历史用例没有全套运行，本轮不宣称整个仓库回归通过。源码测试不等同已部署或 SG20 已完成。

真实 service 边界补验：`node --test --test-name-pattern 'Owner经真实service拒绝' test/workflow-service.test.js`，`docs/tmp/owner-withdraw-service-final.log` 3/3 PASS，10533.5242 ms。current/foreign/old-plan 三种旧修订都拒绝，workflowDigest、Run/generation、执行调用次数不变，Owner 看不到 workflowRevisionCapabilities。初次测试仍断言旧能力存在，ERR_ASSERTION 记录保留于 `owner-withdraw-service.log`，修改测试为当前责任合同后通过。
