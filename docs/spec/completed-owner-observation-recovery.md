# 已完成任务的重复观察恢复

## 现状与目标

PR #126 部署后，阶段观察事件从既有 taskId、planRevision、stageId、status 的稳定身份改为完整 payload 摘要，已完成阶段被重新发布。旧任务的完成决定仍存在，新增空处理回合因旧冻结合同缺失而阻塞，导致 Owner 展示退回等待。部署已进入维护并排空，不恢复旧代码派发。

目标是修复观察幂等性，并以严格原生事务恢复被这一缺陷影响的已完成 Owner，不重做业务执行、不套用新合同、不删除历史错误。

## 实施边界

1. succeeded、blocked、waiting_confirmation 恢复原稳定事件身份，精确保留原数组参数的摘要编码。running 的变化诊断保留 payload 身份。
2. 原生 Owner query 提供只读恢复预检；command 仅在维护已排空时接受，核对维护 revision、Owner revision 和水位。
3. 必须存在已应用 complete 决定；要求、计划、权限、fence、control 版本不变。后续只能是未接纳业务决定的空 released/superseded 回合。
4. 新增未处理事件只能是 workflow.succeeded，且 payloadRef 与已处理的稳定阶段事件完全相同。阶段成功，Run、Node、effect 终态，完成后无执行变化。
5. 事务只标记已证实重复事件并恢复 Owner idle/水位；保留原 complete、失败回合和错误事件，添加恢复审计。
6. 盘点所有受影响任务，不仅限两条 UAT。条件不满足时拒绝自动修复。

## 部署与验证

先运行隔离正反例和活动数据副本的只读预检；部署沿用当前维护许可，经显式身份和 revision 核对、封存、备份和新进程回读，再执行原生恢复。历史完成状态独立回读后才恢复派发。

本轮用户已选择在现有 dataset UAT3、dataset-web UAT2 重跑真实业务验收，不重新构建部署流水线。部署健康与业务验收分开记录。
