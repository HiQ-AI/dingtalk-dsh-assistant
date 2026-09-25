# 第 1 轮定向验证：Task Owner 代码与同库流程

日期：2026-09-25。环境：`D:/project/worktrees/dingtalk-task-owner-runtime`，Node.js 24，本地临时 SQLite/JSONL，会话模型使用脚本适配器；没有触发真实钉钉、UAT、生产或 Bytebase 操作。

执行：`node --test test/execution-store.test.js test/execution-task-plan.test.js test/task-owner-store.test.js test/task-owner-session-native.test.js test/task-general-workflow.test.js test/workflow-service.test.js test/workflow-engineering.test.js test/workflow-uat-proof.test.js test/message-ledger.test.js test/message-workflow.test.js`。首次组合运行 182/182 PASS；之后新增会话换代、报告和验收原子性测试，分别定向复跑 `test/task-owner-store.test.js`、`test/task-owner-session-native.test.js`、`test/workflow-service.test.js` 与迁移单例，均 PASS。新增代码的组合回归需要下一轮再跑。`git diff --check` 退出码 0。

## 已通过的案例

<a id="t01"></a>T01：`test/message-workflow.test.js` 的“三条同话题先全部关联”“同话题新增补充使旧 I 候选失效”证实单次批量判断与重判。

<a id="t02"></a>T02：同一文件的“不同话题各有独立 I 会话”证实输入和会话隔离。

<a id="t04"></a>T04：`test/message-ledger.test.js` 的“同话题补充到达时已执行动作保留，剩余待派发动作重新进入意图判断”通过。

<a id="t05"></a>T05：`test/message-ledger.test.js` 与 `test/message-workflow.test.js` 的编辑失效约束反例通过；已发生效果不被重写。

<a id="t07"></a>T07：`test/workflow-service.test.js` 的“真实同库消息接纳…重复入站不重复创建”和 `test/task-owner-store.test.js` 的事件键/回执重放通过。

<a id="t08"></a>T08：`test/execution-task-plan.test.js` 的确认间隙取消与运行中任务级暂停用例通过，旧确认不能启动后继。

<a id="t09"></a>T09：`test/message-ledger.test.js`、`test/message-workflow.test.js` 的已认证准确控制越过无关归类屏障、其他发送者及普通动作不越权通过。

<a id="t12"></a>T12：`test/task-owner-store.test.js` 的新事件/版本令旧候选失效、接纳后应用前新意图丢弃旧决定通过。

<a id="t13"></a>T13：`test/task-general-workflow.test.js` 的无独立回读、空来源、漏验收项拒绝完成通过；服务默认验收器 fail closed。

<a id="t16"></a>T16：`test/workflow-engineering.test.js` 与 `test/workflow-uat-proof.test.js` 的动态工程 ID、受信注册及同一 Run 证据核对通过。

<a id="t17"></a>T17：`test/workflow-uat-proof.test.js` 的独立 UAT 部署与 Git tree 漂移拒绝通过；仅代表平台适配合同，不代表真实 UAT 已部署。

<a id="t18"></a>T18：`test/workflow-service.test.js` 的方案阶段完成等待确认报告、Owner 最终报告一次性投递通过。

<a id="t21"></a>T21：同一文件的通知 ACK 丢失只读回不重发用例通过；未模拟真实渠道重启。

<a id="t22"></a>T22（部分）：`test/task-owner-store.test.js` 的候选版本冲突、恢复未决 turn 与接纳后应用回执重放通过；还需真实进程杀停点验收。

<a id="t23"></a>T23（部分）：原生 JSONL 会话同身份跨轮复用、已绑定会话确实缺失与 I/O 错误区分、store 受控换代分别通过；还需服务层缺失→换代→恢复完整闭环。

<a id="t26"></a>T26：`test/workflow-service.test.js` 的流程成功后由 Owner 逐项验收再报最终结果，以及未达成时看板等待状态通过。

<a id="t27"></a>T27：`test/execution-task-plan.test.js` 的 v1→v2→v3 链、v3 `--check` 零写、备份与源表摘要回读通过；尚需对真实本地实例单独核查才可部署。

<a id="t29"></a>T29（部分）：群外/无权创建、同任务控制伪装反例通过；真人审批伪造与跨版本目标变更仍需验收。

## 本轮仍未验收

T03、T06、T10、T11、T14、T15、T19、T20、T24、T25、T28、T30 及上述部分项仍为 TODO。尤其日常能力当前只有受信话题原文读取，不能把数据库排查或文件写入宣称为已完成；真实渠道两条历史消息、审批、运行态重启与本地部署均未验证。不得据本轮单测结论开放旧生产控制库自动迁移或外部效果。
