# 第11轮：已归档任务物理迁移

2026-10-29完成。复用正式离线迁移，Check零写后Apply；32个已有归档标记的任务迁入dynamic_archived_*，schema2→3/taskArchiveSchema1。默认物理迁移补齐死亡owner精确CAS检查，保留一致备份与SHA门禁；相关测试5/5通过。

|数据|迁入归档|活动保留|
|---|---:|---:|
|任务|32|1|
|执行|58|5|
|操作|4704|740|
|唤醒|1412|239|
|通知|116|192|
|回执正文|24285|中央1855134条身份保留|
|任务事件|23|11|

独立只读逐条对照迁移前备份，正文、原序号、回执id/digest一致；符合条件的活动残留为0。两条unknown操作、原v4任务与c5/bc执行正文SHA、实例身份均不变。迁移99665ms，独立比对12823ms。

备份：C:/Users/64554/Documents/Codex/2026-10-28/archived-task-migration/docs/tmp/rollback/task-sessions.sqlite；SHA256 1774ea19f5e99a2d992dfc4c318179f7e9d5d1abe3770063ff9f1d012c075051。

同包同profile恢复PID39508，3080/18998同PID；inboundProcessing=true、DWS可用，保留原2条unknown导致的degraded。历史分页两页HTTP200/total32；真实归档task-c49f7192ac80a7290f157c645893d47c详情HTTP200/completed/1执行；原v4详情200。Chrome历史列表可见32条和已归档标记；详情UI检查未收敛（浏览器连接超时），不以API成功冒充UI详情通过。

证据：docs/tmp/archived-task-migration-20261028/{migration-result,verification,http-after,archive-detail-http,health-after,start}.json。未重跑业务验证、重放消息或执行VACUUM。
