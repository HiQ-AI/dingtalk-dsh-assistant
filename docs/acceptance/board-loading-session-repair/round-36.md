# 默认值加列能力与真实校验后受管恢复

可空smallint/integer/bigint仅允许在类型范围内的整数字面量DEFAULT，BigInt精确处理，不放开表达式、函数、NOT NULL或多语句。生产期望默认表达式与SQL常量一致，真实目录回查保留原表达式。

准确旧BYTEBASE_PRECONDITIONS_UNCONFIRMED且无任何effect、全部排空、后续全blocked时，Host调用当前Run冻结validate-package只读校验；现在确实通过才暴露修复。新增Host静态校验事实使用既有sources及repair票据，新gen仍重新生成和实际校验；去掉时间、回执/快照ID及递归sourceDigest，重复真实事实不算新事实。应用与准入再预检，审批和未知效果边界保持。

## 实跑证据

生产public.process_id_temp只读integer DEFAULT0预检passed；未执行DDL。平台及生产Host21/21；Owner恢复20/20、原生会话25/25、领域合同21/21。完整Service3/3覆盖正常新任务、旧空候选恢复和旧前置校验修复，同Task同Run新generation、建单一次、插件pending、批准前执行0。合同反例证实预检仍失败不可修复、支持撤销后旧绑定不能用、不同receipt/snapshot不制造新事实。

通知完整52/52及新增负例1/1、服务通知7/7、内部故障静默4/4；前轮授权8、受信平台9、schema16有效。广泛旧消息Agent/native环境fixture边界仍保留，未声称全仓或CI通过。

## 正式部署

正式包SHA256 880734540e7761aca53e4f725149305ac36780b368d2b2a610b95fa872e3ffa9。Check零写、tasks1、无历史备份。安装及实际业务核验进行中，不能以隔离通过替代原Task送审。

## 实际恢复闭环

同Task/r2、同Owner、同Run自行读取诊断并提交repairCurrentStage，generation3：validate-package及建单/回读全部成功，工单859/Plan880/Sheet27dd1fa...，精确SQL ALTER TABLE public.process_id_temp ADD COLUMN is_deleted integer DEFAULT 0，production目标一致。执行效果账只有create-issue succeeded一次和approval-gate prepared；插件审批pending/revoked0，execute节点blocked，无SQL执行效果。

插件私聊notice waiting-reply，独立钉钉13:33开始窗口complete=true/count1，精确审批消息回读命中1、工单859一致；文案省略SQL，正文要求引用回复批准/拒绝。群12:20至13:34窗口complete=true/count2，只原需求+一次开始，内部进度/受阻0。没有手工补发开始或代批准。

最终包独立安装/Readback/Resume及运行HTTP回读：PID47360、health=ok/inboundProcessing=true、maintenance=false revision429、dispatchResumed=true/autostart=true，前进程53572已退出。普通部署无历史备份。工程修复及实际送审PASS，当前唯一等待为本次插件真人审批；不声称生产DDL已完成。

新增当前Task查询合同对应的全链fixture已按真实Owner/原生query-evidence和受管stageBinding修正，批准/驳回、自动发布、既有工单、加列/删列6/6通过（32928ms）；不放宽生产授权或接纳伪造证明。
