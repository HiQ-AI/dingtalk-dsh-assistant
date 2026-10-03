# 证据引用纠错与原任务恢复

## 原因与边界

成功只读查询返回任务目录下完整引用，模型提交截去 tasks/<taskId>/ 前缀。读取前未验证签发身份，导致 ENOENT 被当成致命提交错误。原始文件存在且查询回执保留，排除文件丢失。目标列值查询曾被范围拒绝，不能用结构查询替代数据查询或擅自扩权。

## 定向验证

- agent-work / agent-query-tools：20/20 PASS；截短、跨Task和拼造引用在读取前拒绝，真实工件缺失仍致命。
- message-agent-controller：19/19 PASS；消息问答从原生回执核验引用，不强制引用所有试探查询。
- execution-session-native 定向：10/10 PASS；真实 scoped 工件先漏引用、再截短、最后完整引用，保持同会话纠正并仅接纳一次。
- workflow-service 定向：5/5 PASS；v6/v7/v8冻结合同、资源变化恢复及原调查安全重试边界。
- 合计54项，未运行全量测试。

## 部署与业务

普通无迁移部署进行中。原Task需求版本4，旧工单加列结果不作为本次删除列批准。新删除工单、插件真人批准、实际执行、生产回查及唯一群完成回复尚未通过验收。

部署完成：Check writes=0；Launch/独立Readback/Resume全部通过。正式包r22b SHA256=1c22a798fdea774e1acbf827d5305d67b1e1d3cbdfedc45311aba2298f780d7f，PID49432，health=ok，maintenance.active=false，DSH Web Local=Ready。无schema迁移、无历史备份副本。

受管retry-investigation已接纳；独立详情回读同Task、同run、requirementRevision4/plan5，investigate进入generation2/running，原失败记录保留。此时只证明恢复执行，尚未证明调查成功或删除工单完成。

原生第二代查询提交独立回读：完整tasks引用已接纳received=true，提交故障闭环。后续AGENT_WORK_BLOCKED是合成需求要求先查业务数据且范围不支持；并发现删除预检/空结果回查能力缺失，转SG23，不宣称本次删除已完成。
