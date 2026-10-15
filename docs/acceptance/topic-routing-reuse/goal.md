# 话题拆分复用与原生失败恢复

> 状态：ACTIVE
> Goal ID：topic-routing-reuse
> 最近维护：2026-10-15T12:45:00+08:00
> 权威目标：D:/codex/worktrees/topic-routing-reuse/dingtalk-dsh-assistant/docs/acceptance/topic-routing-reuse/goal.md

## 总目标

核查现场话题拆分、复用及任务续办，修复重复话题来源与Host失败响应阻塞，部署并验证原身份恢复。

## 完成条件

- 两次指定DATABASE_NOT_FOUND按真实失败收口，不重放、不假记无效果。
- Web续办复用原话题，独立事项及多事项拆分仍正确；现场历史记录可审计修复。
- 定向测试、本地包及原任务读回有证据，PR独立回读。

## 范围与约束

- 保留原任务/会话/操作/来源及既有业务授权；不操作业务部署或共享数据。
- 主检出已有文件不动；基于origin/main并保留已部署PR182修复。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | Host原生失败恢复 | 原错误与绑定调查核验、定向测试、部署及两项失败收据读回 | 完成 | round-9；两项failed/partialEffectsPossible，原session输入版本8继续 |
| SG2 | 话题拆分复用 | 源码根因、回归测试及历史话题安全收口 | 完成 | round-20/final-readback.json；当前2/档案6，顺序及原身份核验 |
| SG3 | 交付与现场核验 | 包/进程/健康/任务及PR状态独立读回 | 进行中 | round-20部署及真实Chrome已读回；待PR更新 |

## 当前检查点

- 当前子目标：SG3
- 唯一下一步：沿现有PR182更新最终实现、提交并独立回读。
- 未闭环项：PR更新与回读；原业务共享影响、两条历史通知读回未核实，原业务等待精确批准。

## 进展

- 2026-10-15：163项Host定向测试通过；已修正独立审查发现的自动通用清账及多笔部分提交风险，操作人答复与全部结算单事务。正在部署及原申请回读。
- 2026-10-15：读取实时六话题、两任务和原调用；Web reuseTopics仅支持new-task，task-context每次新增话题。Host桥接丢失effectClass，真实MCP错误仅unknown；不能据错误文字推导无效果。

## 重大决策

- 失败终态与效果未知分开：只有精确绑定原响应、正常结束、已结束只读调查和操作人显式指定原操作摘要才允许failed/partialEffectsPossible；不推导成功或noEffect。

## 重要信息

- 原task task-4c4780a541c5ea7c51024975de5f121d；原操作d00a661、e132cbb；技术申请human-5e84e76b64942acdbe3b15d6d33f1730d77f89ca962df70ebe041c4d4567a7b5。

- 2026-10-15 12:50：Host包8d9a24dd部署PID7792，原两项failed/partialEffectsPossible，Web原申请answered；原execution/session输入版本8续办，unknown操作0。
- 2026-10-15：定位Web补充重复建题并修复隐式历史版本漂移；历史归并只改当前归属、保留旧版本和已完成决策。独立复审发现取消blocked保留项回归，已精确保留原语义并加实跑回归。

- 2026-10-15 13:01：90a21792包部署PID29832，四个旧Web话题正式归并，当前2/档案6；原任务、执行、操作及版本独立比较完全不变。浏览器确认2话题/1关联任务，但发现迁入早期Web来源排在更新UAT指令后，继续修正读取顺序。

- 2026-10-15 13:09：最终排序修订7ed96f75部署PID55216；160话题/原生回归通过，两个目标实际来源有序。真实Chrome确认当前2话题及原关联任务；原技术申请answered、两失败操作不变，unknown操作0。保留2条历史通知unknown与业务精确批准等待，不扩展处理。
