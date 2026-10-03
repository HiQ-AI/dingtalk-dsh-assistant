# 第十六轮：私聊不展示执行 SQL

仅移除私聊模板的执行SQL段落，保留事项、目标数据库、工单与回复方式；完整SQL仍在审批详情evidence和原生冻结执行内容中。现有私聊已获真人批准，保留已批复消息记录，不编辑历史或新增审批。

完整私聊服务定向5/5通过，明确断言正文不含SQL而evidence仍含冻结SQL。业务执行活动时部署零写预检正确拒绝，等待排空后通过；精确新包 `d19d1ae9aa2a03ece441303ccc06c2de62434fd8540125fe064eea3bdc8c6d14` 已安装，新PID41592、health=ok。正式API独立确认正文不含执行SQL，审批详情保留完整SQL和真人批准状态。

部署按runbook Check、安装、Readback、Resume，无历史副本。私有测试与运行证明保存在 docs/tmp/private-approval-without-sql-* 及 simple-database-change-20261002/private-approval-without-sql-live.json。未发送新审批消息，不把模板修改当作生产执行完成证据。
