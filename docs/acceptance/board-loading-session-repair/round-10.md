# 第十轮：原生空列表回读与真实审批配置等待

仅合法完整ProtoJSON空对象{}或明确taskRuns数组可以解码；null、错误对象、缺列表但带其他字段均拒绝。冻结v5节点不改。已有工单readback-issue恢复按冻结只读节点的实际成功校验准入，不按错误名称逐个加例外；输入封套、定义、节点、代际、租约、控制、维护与未知效果仍完整核验。

两平台定向文件35/35通过（真实{}预建Task全路径与八类响应形状），最终服务恢复与审批屏障16项待统计。原工单857/Plan878/Task905保持；独立只读门户再次确认SKIPPED、NOT_STARTED、原始TaskRun响应{}；生产只读name列仍空。第七包待部署及真实等待/群说明独立回读。

最终服务原工单恢复、不同协议错误恢复、审批投影及维护/控制屏障16/16通过。

## 最终运行与独立回读

第七正式包 `zzusp-dingtalk-dsh-assistant-1.0.0-simple-data-change-round7-20261002.tgz` SHA256 `9e3f0c216566e3c893aaa247da07bdb939ceca06565cf3de8f01a884a19b175a`；源码/安装100文件一致，PID45200。按部署runbook执行Check零写、备份、安装、Readback、Resume；安装阶段readback尚未恢复收信，最终Resume及延迟健康独立确认维护解除、health=ok、inboundProcessing=true。私有证据：docs/tmp/simple-data-change-deployment-round7-20261002/installed.json、launch.json，以及docs/tmp/simple-database-change-20261002/deploy-round7-resume.log。

原 Task `task-e7e25daf5c0aac2f8bcb5ef13daef45f` 需求r2/计划r3，保留三项成功调查；数据变更Run `run-e6fefb6532c0038c1af50ea32abd730ae7661f9c712a5d4de2fb61aebd52775f` 使用v5。审批节点waiting，代码BYTEBASE_HUMAN_APPROVAL_NOT_CONFIGURED；Owner idle、last_failure=null，原Task active。详情明确缺失、Bytebase管理员责任及启用规则后重新送审的恢复条件。原工单只读身份错误已解除，未重建工单。

独立Bytebase回读：Issue857、Plan878、生产hiq_editor、Task905；SQL为 `ALTER TABLE public.process_id_temp ADD COLUMN name character varying;`，Sheet SQL摘要 `38a91faf622d0ad246ccb0a2c03b4c37f6746aa3254c9db0dcf5f0a8d4f56b2e`。Issue DONE且审批SKIPPED，Task NOT_STARTED，TaskRun原始响应{}；DONE不代表执行。原生生产发布策略rolloutPolicy={}，automatic默认false。独立生产副本pg_is_in_recovery=true、transaction_read_only=on，目标name列查询rows=[]。未批准或执行生产DDL。

群“广场与编辑器迭代”：错误身份等待消息msgbWKUUNwuFIPWLiEChf383Q==撤回后精确七天查询count=0；正确配置等待消息msg/VQoW8QGD5Rb+GRHzye8Aw==，2026-10-02 12:49:51，独立查询complete=true/count=1/failedCount=0。说明包含缺少原生人工审批规则、管理员责任和本次精确SQL重新送审条件。当前Task的引用源精确查询开始通知count=1，原消息msgWV8D6UBkeEsqZkmupsKGBw==保留；没有额外发送开始通知。证据group-native-wait-final.json、group-start-final.json。

最终接口抽查groups 2414ms、详情2748ms，投影为capability等待。此次抽查是API耗时；真实浏览器及目录/完全权限/群名验收引用round-2.md，不冒充本轮新浏览器验证。

实跑：`node --test test/workflow-platform-clients.test.js test/workflow-data-change-external.test.js` 35/35；`node --test --test-name-pattern='Bytebase 已建工单身份只读恢复|Bytebase 原生审批 Service 自动对账|交付只读恢复屏障' test/workflow-service.test.js` 16/16。未累加与旧轮重复的测试数。当前最新用例均PASS，旧轮真实FAIL保留。修复范围已完成；原生产业务任务仍等待管理员启用审批并重新送审，不能把SKIPPED工单直接执行，也不能承诺配置变更后旧工单自动变成PENDING。
