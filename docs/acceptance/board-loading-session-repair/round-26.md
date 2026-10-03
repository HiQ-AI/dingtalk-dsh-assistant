# 已核验原始事实的完整交接

承接round-25真实验收反证：原生程序掌握的目录观测和审批呈现材料未交给领域验收，模型误认为尚缺证据。修复沿既有原始查询和审批执行证明返回，不重做业务操作，不修改冻结v4/v5 reader或readCompletion函数源码。

生产查询返回其真实relation_kind、column_exists与columns结果，Bytebase回查保留；approval.execution-proof沿原request/effect/审批人/材料摘要/投递事件与批准顺序传递实际呈现正文。没有真实呈现记录则不制造风险告知证明。领域语义判断不得擅自将Host已准入生产只读来源扩大为主库要求，证据矛盾仍拒绝。通用验收26/26测试通过。

`node --test test/execution-effects.test.js test/workflow-bytebase-platform.test.js test/workflow-postgres-production-host.test.js` 66/66通过：原始目录观测传递、批准前呈现、批准后撤回、缺失/过晚呈现不捏造，错审批人/摘要/消息拒绝。`test/task-release-workflows.test.js` 15/15保证冻结v4/v5相关回归，readCompletion函数体未改。新queryEffects对真实#858只读回查确认presentation存在、正文含永久数据丢失、投递早于批准且有原消息身份。

包SHA256 `90f568351b8bff08a791e8ebd2480d10eea2f72f3431227bf780f1b2cbdd41da`；正式Check/部署/Readback/Resume通过，PID44112、health=ok、维护解除revision396、自启Ready。原Task readonly reassess event255后再次提交完成仍被拒绝：冻结调查合同要求缺失证据由后续阶段补齐，最后stage7不能引用前序stage6原生执行事实。全部7阶段成功且原始证据齐全仍失败，不能宣称业务完成。该反证由round-27修正。
