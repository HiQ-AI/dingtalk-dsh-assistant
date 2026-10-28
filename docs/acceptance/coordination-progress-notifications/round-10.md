# 第10轮：本地运行看板恢复

## 现场与修复

本地PID33984的health/入站正常，但任务分页、历史分页、待答复和详情HTTP503，实际Chrome任务看板显示OBSERVER_PAGINATION_MIGRATION_REQUIRED。动态库metadata确认observer_*对象为0；此前以进程/入站判断本地已恢复不充分。

复用原迁移脚本新增indexes-only模式，不物理归档、不改源业务正文、不升归档schema、不计算整库摘要或完整性扫描。Check零写，Apply单事务，精确旧owner CAS+PID死亡校验；保留owner，失败回滚。原默认备份及物理归档合同保持。

## 实际执行

1. 原c5及最后只读核验、Owner自然排空，current-control online通过后原生SIGINT停止精确PID33984。保留捕获进程身份，只清理已死亡收信父进程的原只读broker，不中断业务。
2. 新独立进程回读offline控制通过（原操作两条unknown仍保留）。原生退出后遗留27,838,872字节WAL，在精确owner/PID死亡Check后仅checkpoint TRUNCATE，busy0/WAL0；未跑全库审计。一次同shell控制台句柄错误保留，未重发SIGINT，在新shell继续离线读回。
3. migration Check ready=false、applied=false；Apply ready=true、archivedTasks0；再次只读Check ready=true。实际Apply887ms，生成58个observer_*表/索引/触发器，覆盖33任务、63执行、68人工请求。不同原投影按需要读取对应源表，未声称单遍扫描。
4. 独立回读确认instance/init/owner指纹、原Task919及原c5/bc正文SHA完全不变，application_id与user_version2保持。无历史正文搬迁，也未复制历史库。
5. 同包同profile启动新PID13436，双端口、入站/DWS恢复。未重打包/重装；profile摘要6fe4ab69345680bd24dbf7cb00ffd33cda72a80555a5dafc3bd19bfac0814e7e保持。

## 验收

- 迁移相关29/29通过；部署看板就绪门禁13/13通过，真实临时HTTP覆盖health正常但分页503、非分页结构拒绝及正确结构通过。
- 8个真实分页/详情/群/话题HTTP全部200，任务已结束1、历史32、话题46、待答复0。原Task919详情status completed、需求/控制13/13。
- 实际Chrome原标签自动恢复“运行正常”，任务列表可见原v4已结束卡；点击后详情、结果、5执行及时间记录真实加载成功，无原503提示。截图board-restored.png与task-detail-restored.png在本轮docs/tmp/observer-index-recovery-20261028下，未提交二进制。
- 新部署脚本在health之后单次读取任务/待答复分页，各limit1；503或结构异常记录observer-readiness失败，不重试、不自动迁移。该helper现场实跑ready=true、taskTotal1、pendingTotal0。

原始记录在docs/tmp/observer-index-recovery-20261028，包括迁移Check/Apply/独立回读、业务指纹核验、HTTP前后、停机/启动及页面截图。现有旧unknown效果保留；不把看板恢复说成所有历史告警已解决。未运行CI、未重跑UPR业务验证或发布。
