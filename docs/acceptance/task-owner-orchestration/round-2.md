# 第二轮定向验证

2026-09-25 在隔离测试控制库运行：

```powershell
node --test test/execution-store.test.js test/execution-task-plan.test.js test/task-owner-store.test.js test/task-owner-session-native.test.js test/task-general-workflow.test.js test/workflow-service.test.js test/workflow-engineering.test.js test/workflow-uat-proof.test.js test/message-ledger.test.js test/message-workflow.test.js test/workflow-approval.test.js test/task-release-workflows.test.js test/workflow-data-change.test.js
```

结果：204/204 PASS，进程退出码 0。本轮没有连接真实平台或渠道，也没有部署本地实例。

阶段间取消后重新打开的反例先后暴露 `TASK_PLAN_REF_INVALID` 与 `TASK_CONTROL_STALE`。修复为将原发送人的重新授权消息固化成内容地址工件，并在 `task.control.reopen` 已递增需求版本后，以当前版本修订未完成后缀；同一用例重新通过。运行中任务级恢复同时唤醒已暂停的 Run，用例通过。

<a id="t15"></a>T15：`test/workflow-service.test.js` 的“前序产物以受信引用交给通用步骤，严格输入 schema 可读取”通过。仅证明当前已登记通用步骤的类型化交接。

<a id="t19"></a>T19：`test/workflow-service.test.js` 的“账号问题与‘这不是让你去查吗’回到同一Task，不重建或丢失原上下文”通过。使用隔离夹具；历史真实渠道未重放。

<a id="t23"></a>T23：原生会话测试分别证明已绑定会话缺失与存储 I/O 错误不可混同；`test/workflow-service.test.js` 新增服务层闭环，已绑定会话确认缺失后换代，重启恢复仍为原 Task、仅一份计划且 Owner epoch 更新。不以 I/O 错误重建。

其余 TODO/部分用例维持未完成，不把组合单测总数当作全部验收通过。

补充派发门禁后，`node --test test/execution-task-plan.test.js test/execution-effects.test.js test/workflow-approval.test.js test/workflow-service.test.js` 为 85/85 PASS；另两条定向反例证明任务级暂停落盘后不能领取节点，以及取消落盘后已领取节点不能再准备或启动外部效果，即使 Run 的异步停止尚未完成。

真实本地控制库 `D:/dsh_home/workflows/runtime-v2/control.sqlite` 的 v3 迁移 `--check` 返回 `fromVersion:2`、`toVersion:3`、`writes:0`，当时有 1 个 Task、5 个 Run、13 条效果、0 个 unknown effect 和 0 条待审批；原表摘要已记录在命令输出。另取 `D:/dsh_home/backups/host-bfacebf-20260925/control.sqlite` 的隔离副本执行 `--check` 和 `--execute`，源表摘要一致、`schemaReadback:3`，并生成 `pre-task-owner-v3` 备份。活跃库仍为 v2，未执行本地切换。
