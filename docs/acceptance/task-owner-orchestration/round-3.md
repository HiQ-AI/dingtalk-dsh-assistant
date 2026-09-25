# 第三轮定向验证

2026-09-25。本轮针对 Owner 强杀恢复、审批绑定与派发门禁补证，使用隔离 SQLite 和合成平台适配器，未触发真实生产操作。

- `node --test --test-name-pattern='Owner候选落盘后进程强杀|Owner已接纳的追加阶段落盘后强杀' test/execution-store.test.js`：2/2 PASS。候选持久写入后强杀持库进程，重新打开仍保留原 Task、事件和 Owner 会话身份，候选变为待重判，旧租约接纳被拒绝。新租约事务接纳后再次强杀，原决定及应用待办仍可读回。另一进程在追加阶段命令写盘后、Owner 应用回执前被强杀；重启时原命令回执复用，阶段没有重复追加，Owner 应用回执仅结算一次。
- `node --test test/workflow-approval.test.js`：1/1 PASS。真人批准后把生产目标资源从原服务改为另一服务，被 `DELIVERY_IDENTITY_CONFLICT` 拒绝，外部发送数仍为 0；原精确对象随后只发送一次。
- `node --test test/workflow-data-change-external.test.js test/workflow-approval.test.js test/task-release-workflows.test.js`：17/17 PASS。生产发布及数据变更均在受信效果账等待真人审批，Bytebase 工单回读不代替 Assistant 审批；工单 Sheet 内容漂移在审批前后均阻止生产发送，未知回执只对账不重发。无权或跨任务审批被拒绝。同任务无权人员不能创建或控制任务的反例见第二轮 204/204 组合测试中的 `workflow-service` 用例。

<a id="t11"></a>T11：上述目标资源替换与数据变更工单内容漂移反例证明，原审批不能用于变更后的操作；仅为隔离适配器功能验证，不代表真实生产系统已批准或执行。

<a id="t22"></a>T22：候选提交前后、决定事务接纳后、应用命令已写而回执未记三个真实进程切断点分别验证；事件、决定和阶段命令保留，旧租约失效、原命令只应用一次。

<a id="t25"></a>T25：生产发布、数据变更两类固定流程的 Assistant 真人审批门禁及 Bytebase SKIPPED 不放行逻辑通过隔离验证。

<a id="t24"></a>T24：`test/execution-task-plan.test.js` 的“外部效果已发而回执未知时取消只阻止后续派发，原效果仍待对账”通过：效果许可先发出，取消后未知回执保留，后续效果被拒绝，Task 不能提前结算为已取消；未声称外部动作未发生。

<a id="t29"></a>T29：无权追问/控制既有任务与伪造审批分别在 `workflow-service`、`workflow-approval` 测试中拒绝；合法已建任务没有因此被追溯取消。

<a id="t20"></a>T20：同一 Task 的承接与最终报告都已回读时，只对明确指定的最终通知执行受权纠正和撤回；承接通知保持已送达，渠道撤回调用恰好一次。测试不按 sourceMessageId 批量处理，也不把有效承接视为错误。

<a id="t03"></a>T03：同一来源话题含排查 A 与排查 B 两个独立 Task 时，短追问“排查A呢？”经 R 候选及目标证据绑定到 A；即使 B 是较近执行的 Run，也不默认选 B，不新增第三个 Task。

<a id="t10"></a>T10：已完成 Task 的“报告改成中文”作为 `report` 意图与原 Task 的 `report.preference.changed` 事件进入 Owner；新增一份最终报告并独立回读，原任务仍只有一个 Run，排查流程未重跑，原有效报告保留历史。

<a id="t28"></a>T28：同一 Task 积压 120 条带较长原文的事件，Owner 快照转为内容地址分页；会话逐页读取后，处理水位推进到全部事件并沿用原 Run。未读页的候选被 Host 拒绝。原生会话的分页读取工具实跑通过；相关消息侧容量/归类等待用例见 `message-workflow.test.js`。超过本轮受控页面容量时显式报 `TASK_OWNER_INPUT_CAPACITY`，不会静默截掉事件。`node --test test/workflow-service.test.js test/task-owner-session-native.test.js test/message-workflow.test.js` 为 109/109 PASS。

<a id="t30"></a>T30（部分）：`node --test --test-name-pattern 'LF/CRLF' test/execution-controller.test.js` 为 1/1 PASS：相同函数的 LF/CRLF 源码得到相同新摘要，旧 CRLF 原始摘要的 Run 与计划阶段均恢复完成且保留旧摘要；实际实现改变仍产生不同摘要。`pnpm --dir packages/dingtalk-dsh-assistant pack --pack-destination ../../docs/tmp/task-owner-package` 生成 0.5.15 包；独立解包核对 `execution-controller.js`、`workflow-service.js`、`task-owner-controller.js`、`task-owner-session.js` 四个文件与源文件 SHA256 全同。两个独立 Node 进程各自导入源文件和解包文件，定义摘要都为 `8bd2d5a122fe400abaeddfb6219060e649f0ddd260ad5036bb085a34ff54840d`。尚未合并安装到本地运行实例，因此不把打包验证当运行态恢复。

<a id="t06"></a>T06（编排控制合同）：`node --test --test-name-pattern '排查、方案、真人确认、开发、UAT' test/execution-task-plan.test.js` 为 1/1 PASS。隔离控制库中的四个独立 Run 均属于同一 Task，Owner 每次醒来保持同一 sessionId，阶段结果和确认等待以事件返回该会话；每段只在前段成功并绑定真实输出引用后启动；方案确认前开发 Run 数保持为 2，UAT 阶段最终只启动一次，重复恢复不新增 Run。本用例用纯代码合成流程检验业务计划合同，真实工程来源包及 UAT 平台适配器还需分别验证，不能把此结果称为已完成真实 UAT 提测。

<a id="t14"></a>T14（部分）：受信 `read-approved-file` 要求绝对工作区根、显式相对路径清单和 Task 作用域二次授权；逐级拒绝符号链接，打开句柄前后核对文件身份，限制 12 KiB 严格 UTF-8，执行后独立再读核验。`node --test test/task-general-workflow.test.js test/workflow-service.test.js` 为 68/68 PASS，后续句柄强化的单文件定向复跑 7/7 PASS。当前本地配置未提供该能力授权或平台只读适配器，文件写入也没有效果账适配器；现有 `task-general` 仍有第二个规划/汇报 Agent，故不能认定默认日常流程完整符合方案第 9 节。
