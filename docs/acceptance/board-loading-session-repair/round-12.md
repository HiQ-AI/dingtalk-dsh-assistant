# 第十二轮：原生事件索引与实际性能

## 根因与反证

第十一轮最终包的真实Task详情17010字节，PowerShell直连约3.6–4.1秒、localhost约5.5–6.2秒；Node原生fetch直连3965/4334毫秒，health31/7毫秒，排除PowerShell整体连接开销是全部根因。

独立只读当前完整详情正文约0.3–0.4秒，Run热查询0.1–0.3毫秒、原生工件读取2–5毫秒；排除Run增加或工件正文解释秒级延迟。通知轮询原314次查询约1356毫秒，其中重复task.deleted按kind扫描约459MB事件表，是共享原生worker的真实热点。

对同一SQLite原生备份的两份副本，只在一份新增execution_events_kind_seq(kind,seq)。EXPLAIN由全表SCAN变按kind SEARCH，quick_check=ok。并发详情及真实通知轮询332次查询，反向顺序复测：无索引详情444毫秒、整体1877毫秒；有索引详情61.8毫秒、整体191毫秒。两者详情17010字节、18个详情查询、总332查询完全相同，去除动态sampledAt的响应摘要一致。无索引高负载轮次整体约4.8–5.7秒；不是用截断数据或缓存业务状态制造提速。

32次task.deleted查询涉及13个不同Task，其中31次为已删除Task；本轮缓存仍需13次全扫，不能作为根治。原生事件索引覆盖同因的详情、删除、审批及后台历史查询。

## 实施与验收

前置方案为docs/spec/execution-event-query-index.md。schema8新库建立并严格校验索引；旧schema7经零写check、封存排空、完整备份、独占锁和事务受控升级，不在启动时静默写入。

原生store最终38/38、迁移8/8、部署专项PowerShell15/15通过；schema8审批接续20/20与通知49/49再次实跑通过。备份完整性与较早7项迁移联合40/40通过，不累计重叠测试数。旧PowerShell全夹具在当前与独立原HEAD同样于11组后失败，确认为既有离线修复许可夹具问题，不冒充完整绿；未修改无关路径。发布冻结hash既有失败仍见round-11。

正式Check退出0，writes=0、100文件一致、空间足够。原生维护/封存、禁用自启、停止旧PID、checkpoint通过；完整备份961个文件并由一致SQLite副本独立回读。原生7→8事务迁移和独立全表摘要核验通过，仅版本与索引改变。第十三正式包SHA256 138afab8f0beeac9e68cc13c152495c57a0443700048f45d33fec5ab0115e610，100文件独立一致，fresh PID43592；Resume退出0、dispatchResumed=true、maintenance.active=false、历史verified。计划任务原restore=true，最终State=Ready。worker源码/安装SHA256独立一致06fe665556870b4a7c832b078d71aa8ee69962977a4f5047a3d81bdef76013d0。

正式控制账独立readOnly：PRAGMA/meta版本均8，索引列kind/seq，EXPLAIN命中execution_events_kind_seq。health=ok/inboundProcessing=true。原Task r3/p4和三项成功stage完整DTO与切换前相等，同一插件请求decision=pending/status=waiting-reply，waitingCondition.kind=approval。

同一Node测量脚本、127.0.0.1、相同响应字节数：

| 接口 | 修复前毫秒（三次） | 修复后毫秒（三次） | 字节数 |
| --- | --- | --- | --- |
| groups | 2447 / 2350 / 1848 | 481 / 455 / 406 | 3378847 |
| 原Task detail | 4274 / 4785 / 2781 | 172 / 121 / 145 | 17010 |

原工单857/Task905独立回读NOT_STARTED、TaskRuns原始空对象，SQL摘要保持；生产只读副本name查询仍rows=[]。群Bytebase七天complete=true/count1/failedCount0，只保留指定短句。第十一轮性能FAIL经本轮正式运行PASS闭环，不覆盖历史失败。当前浏览器安全校验不可用，未复测页面点击，不将API实测冒充UI验证。

私有原始计时与配方放docs/tmp/task-detail-readonly-profile-20261002.log和task-detail-{baseline,indexed}-contention[-round2]-20261002.log，不提交业务工件。
