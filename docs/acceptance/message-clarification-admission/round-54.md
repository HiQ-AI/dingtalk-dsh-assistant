# Round 54：Owner读取纯校验失败的诊断身份

## 根因与修复

SG20真实恢复目标为inspect-and-propose，失败工件属于紧邻validate-proposal。原Owner要求失败工件与恢复目标同node/lease/input，因而读完正确诊断仍被TASK_OWNER_RECOVERY_DIAGNOSTICS_UNREAD拒绝。

worker恢复快照新增validationLeaseEpoch/validationInputDigest，配合原validationNodeRunId；ExecutionController复核原validator当前身份与纯校验关系，Owner仅此明确Host分支匹配validator失败身份。普通Agent继续匹配自身身份；两类均要求同Run、generation、精确lease与输入摘要，全部证据本轮读取与引用。没有新增恢复入口，没有修改原业务候选。

## 验证

- `node --test test/task-owner-recovery.test.js`：21 PASS，日志docs/tmp/sg20-owner-validator-regression.log。新集成用例走真实store、TaskWorkflowContracts、ExecutionController及OwnerController；错误node/lease/input/generation/run诊断全部拒绝，随后读正确validator诊断，原Agent与validator同代续行，prepare不重领，原session/node保留。
- `node --test --test-name-pattern='工程候选纯校验退回' test/execution-controller.test.js`：8 PASS，日志docs/tmp/sg20-owner-validator-execution.log。
- `node docs/tmp/sg20-owner-copy-identity.mjs`：仅对live SQLite使用只读连接和原生backup，在docs/tmp隔离副本用正式维护命令解除副本屏障。新node.recovery返回repairable=true、generation4、原validator lease1；读取原Task失败工件并核SHA后，完整诊断身份匹配=true。证据docs/tmp/sg20-owner-copy-identity-proof.json。现场DB没有写入。

本轮源码已冻结，部署与原Task实际续行由主线程执行，本结果不宣称现场Task完成。
