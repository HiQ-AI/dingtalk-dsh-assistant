# Round 1：正式只读取证与根因确认

2026-10-28，正式 SQLite 以 node:sqlite `{readOnly:true}` 打开；未启动 Store、迁移、业务执行或群外发。取证脚本和精简结果分别为 `scripts/read-live-evidence.mjs`、`round-1-live.json`。

## 已证实

- 09:42:05 收到“昨天关于导入的其他问题 修复了没”；09:44:09 接纳四成员纯观察 arrangement。原提案写明“本次仅询问”，但实际保存持续观察。
- 09:45:21 收到“直接查询任务进展就行”；09:47:26 查询旧安排并发送四行同名“原事项”。
- 错误安排 summary:2..6 共五条独立 delivered；不同通知ID排除同一传输重试。最后一条正文逐字匹配用户提供内容（渠道时间与创建时间不混同）。
- 四成员 `commandKind=coordination.observe`，无 mutation receipt、无依赖。不是该安排直接重启四项业务。
- 四个“原事项”各对应一个 Task，不是历史摘要递归。此处纠正初始假说。
- 新草稿任务 requirementRevision 2→3 的直接来源为 Web 显式 maintenance resume，receipt `topic-operation:decision-f1b905f91559cc830abbd57fdd318d2c:action:0`，2026-10-28T02:45:19.877Z；来源 `web:b1211e34a52f3642ce0c9c700b0ed62649ca20a00a5cc186afd91737d5f4423b` 的 requestIdentity.action.kind=task-reopen。询问消息出现在 sourceRefs 不足以证明它触发重开。

## 四事项的核对边界

| 事项 | 只读账本状态 | 本轮判断 |
| --- | --- | --- |
| 终审只读 UPR | completed，完成时间 10月26日 | 观察冻结版本仍匹配，显示完成 |
| 未保存新草稿 UPR | active | 后续维护恢复改变版本，旧观察失效，不等于用户改需求 |
| 物料名称回显 UPR | completed，完成时间 10月28日11:02 | 原观察仍冻结旧版本，无法代表当前结果 |
| v4 合并来源 UPR | active | 后续恢复改变版本；内部结算诊断进入旧协调通知 |

这些是任务控制账证据，不是本轮独立业务/UAT验收。未重放、部署或发送上述任务的任何动作。

## 反偏置

至少比较三类原因：传输重复发送（不同ID排除）；摘要递归（四成员逐行排除）；一次性查询被建成持续观察（原始提案、成员、通知序列确认）。发送机制的问题是生成了多个通知，不是重复投递一条。

## 待验证

修复后的单元、集成、原生隔离路径；真实模型/正式安装/渠道均尚未验证。
