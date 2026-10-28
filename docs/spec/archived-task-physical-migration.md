# 已标记归档任务的同库物理迁移

## 目标
用户明确要求把已归档任务的数据库数据迁到同库归档表。本轮仅选择已有archivedAt标记的任务，不把普通completed自动归档，不迁外部文件、不压缩SQLite。完成判据为对应任务及合格历史记录进入dynamic_archived_*，正文/身份/序号/digest守恒，未决控制记录与共享来源保留，活动任务与历史分页/详情都正常。

## 实施
复用migrate-observer-pagination.mjs默认物理归档合同及archiveTaskRows，不用indexes-only替代。原schema2的首次物理归档切schema3/taskArchiveSchema1，按既有runbook在自然排空与原生停机后checkpoint并保留一致性回退备份、校验摘要；先Check零写再Apply单事务。原生停机可能保留死亡owner，因此将已有完整owner CAS+PID ESRCH检查统一适用两种模式，保留owner字段及默认备份/hash门禁。只读预查标记任务资格、双驻留冲突和容量，发现异常先报告精确记录，不手工删改或清除未知效果。

执行历史仅终态且drained；操作仅succeeded/failed/cancelled；唤醒仅acked；通知只迁满足原合同的终态且问题已撤回。未知/在途效果、未送达/未召回、协调/群/共享来源仍留活动控制。独占任务回执正文迁归档，中央id/digest/必要决策头保留；共享回执不搬。

## 验证
保留现有fixture，新增默认物理迁移在一致性备份下接受精确stale-owner、拒绝错误owner/活PID。现场记录已标记任务集合及迁移前归属计数；完成后按目标集合验证零活动任务残留，归档正文/序号/digest守恒，活动控制保留、实例身份不变，重复执行无新增迁移。启动同包同配置，验证活动/历史分页、原v4活动任务与一条真实归档任务详情及浏览器显示，不重跑业务测试或重放外部操作。
