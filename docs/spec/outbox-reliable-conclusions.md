# 群聊通知只发送可靠结论

DSH群聊通知与业务系统通知队列分别管理。业务通知停发配置不因群聊维护而开启。

自动通知仅包含已应用的最终报告及结构化、需要用户补充业务资料或权限的稳定阻塞。任务接纳、排队、启动、内部恢复、审批等待、执行或能力故障不逐条外发。继承内部确认事件不能使普通进度或未知报告类型获得发送资格。用户主动查询/控制和明确澄清保留现有回复协议。

生成与领取共用`taskNotificationAllowed`。领取还核对最新source/run、任务需求版本、执行Run和Owner报告及应用状态；旧通知不因恢复扫描成为当前结论。需求修订在原事务内退休同Task、旧版本、未领取的complete/wait/block报告通知，保持正文和报告历史。只有`prepared && leaseEpoch=0`可自动退休；ACK、未知发送和已送达历史不改，只核对真实送达。

原有稳定eventKey、notificationId、单条领取和ACK/独立回读协议继续生效。外部调用结果未知不得新建身份或重新发送，迟到回执仍应记录真实messageId。发送后状态变化不能撤销已经开始的网络调用；后续纠正须依据实际送达证据和独立授权。

审计脚本`scripts/audit-outbox-readonly.mjs`只使用正式GET状态接口，写当前工作目录`artifacts/outbox-audit.json`。存在多Task来源或缺少当前事实时返回无法判断，不按正文猜测过时。分类用于人工复核，不自动取消或发送。

旧积压通过独立正式入口退休，不开启全局外发。`GET /workflows/notifications/<id>/retirement?supersededByNotificationId=<id>`零写预检；`POST`同路径只接收单条替代通知ID、requestId、expectedFactDigest。入口限定本机及既有Web身份，不接受自报actor、批量目标或发送参数。

预检与命令共用当前控制账事实：原通知必须prepared、leaseEpoch0且无任何开始、尝试、ACK、未知错误或送达证据；替代通知必须同群、同Task、真实delivered、未撤回、最新已应用complete报告且需求/计划/控制版本及Owner水位当前。只有旧启动、旧Owner complete/wait/block报告代次/需求变化或旧状态查询Run被最新Run替代的明确证据可退休。已完成Task的当前Run查询不会仅因Task完成而退休。

自动启动意图撤销是独立窄分支：必须为持久`task:started`、`task.started:<taskId>`身份，来源同一message Run的已应用create/research命令、命令结果与通知事实指向同一真实Task，当前`taskNotificationAllowed`明确false。保留prepared lease0/无任何发送证据、来源及获准群校验、同群同Task已送达未撤回且已应用complete的历史参考、原事实CAS和审计；不要求Task原生succeeded或历史计划绑定当前，也不据历史参考宣告当前Task完成。服务器理由为`automatic-start-policy-withdrawn`。其它Owner报告、查询和wait/block不进入此分支，沿用原有最新结论/版本/权威终态守卫。

POST在控制账原事务内再读取全部事实并比较摘要，保存superseded、服务器推导原因、替代通知及真实messageId、授权身份、证据工件引用和原始摘要。原正文、旧报告、业务Task/Run不改。该命令始终dispatchEligible=false，不调用渠道适配器；维护或全局外发关闭时也可执行。重复同一requestId与摘要返回原记录；更换目标/摘要拒绝。未知发送只能核对，不能退休。

`node scripts/retire-outbox-notification.mjs <noticeId> <replacementId>`默认仅GET。经审阅后单条执行须显式追加`--apply <requestId> <reviewedDigest>`；脚本先重新GET并匹配摘要，再POST退休。没有发送、撤回、补发、维护切换或数据库调用。

定向验证覆盖静默启动、遗留启动领取时失效、旧稳定阻塞需求变化及事务回滚、旧通知晚到、并发重复、重启恢复、未知送达不重发和迟到真实读回。单测不代表真实渠道已部署或送达。
