# 第十五轮：审批私聊可读性

## 问题与修复

旧模板重复拼接资源键、工单、长摘要和完整请求ID；钉钉软换行将正文连成一段。模板改为加粗标题、事项、目标、工单、完整SQL和回复方式，各自独立成段，仅展示短审批编号。完整请求及摘要仍在后台审计，生产/UAT使用对应目标、环境、提交和标签字段。

真实消息编辑第一次发现钉钉不保留列表换行及标准代码围栏的原始文本形式，未将工具成功当作排版完成。最终使用段落和完整SQL原文，独立mget确认每项信息分段且正文精确一致；只归一平台段落硬换行及软换行，不折叠SQL内部空格。短编号仅用于检索，认领仍需完整正文和权威收件人。

## 验证

- 真实SQLite + 服务 + 私聊审批完整链5/5，覆盖数据变更、UAT/重建布局和原审批决定行为；DWS适配器/桥接77/77，补短编号检索、段落回读和SQL差异拒绝。
- 原#857消息原位编辑，独立mget完整回读成功，保留原消息ID、请求、执行内容与审批人，未补发或创建新审批。原生冻结通知保存最初发送内容作为审计；现展示正文由当前模板核验。
- 新包SHA256 `8e2134d03e10a8424a0112bd1ad6ab872159899214e82684b1e057db7d678925`，新进程PID10732、health=ok。部署按既有runbook Check、安装、独立Readback与Resume，无历史副本；核验汇总保存在私人docs/tmp，不加载文件明细。

私有消息前后、部署与最终只读验证在docs/tmp/simple-database-change-20261002/private-approval-readable-*及docs/tmp/private-approval-readable-deployment-20261002。真实审批仍待真人回复；不是生产执行完成报告。

部署恢复后的独立API、只读SQLite、mget及完整私聊查询确认pending/waiting-reply、仅1条消息、health=ok、maintenanceActive=false。Bytebase Task905仍NOT_STARTED、TaskRuns{}，生产只读name列为空。
