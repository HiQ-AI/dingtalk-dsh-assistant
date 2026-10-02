# 当前调查策略选择与拒绝诊断

承接round-27完整原Task反证，按investigation-result/v2结果结构选择Host验收策略，取消易漏项的Owner版本名单。实际调查v6/v7/v8/v9分别合同2/3/4/5，均保留冻结定义；领域内容与效果核验继续执行。

本轮必须覆盖真实全部7阶段前置、当前v9复合正反例、显式失败诊断、正式部署及原Task最终完成。验证待完成，状态以matrix.csv为准。

实际原Task完整只读复现：`docs/tmp/simple-database-change-20261002/complete-seven-stage-readonly.mjs`，日志`docs/tmp/complete-seven-stage-readonly.log`。原selector第7阶段合同5返回false、语义调用0；结构selector七阶段技术校验全通过，仅stage6/7两份显式绑定事实进入一次语义stub，writes=0。使用真实Bytebase/生产只读查询证明当前目标及历史证明，stub只验证准入路径，不代替线上模型验收。

最终定向命令：`node --test test/agent-work.test.js test/task-release-workflows.test.js test/investigation-domain-contract.test.js test/task-workflow-contracts.test.js test/task-delivery-manifest.test.js test/task-owner-delivery-manifest.test.js` 68/68通过（continuous-final-all-contracts.log）。真实Service v9、外部v5、混合调查/写入、重启及完成证据/诊断定向15/15通过（continuous-final-v9-service.log）。具体拒绝包含当前计划版本、阶段、合同和缺失清单；已存在领域diagnosticRef与异常原样保留。

候选包SHA256 `379512736e5f1f28f2aebdb2d238079e62bb924f0a4618bcd7db127ce235f650`，零写Check通过。部署期间DWS完整读取00:17:55至04:47群历史：complete=true/hasMore=false/failures=[]，仅源需求与修复前旧开始通知2条，没有本轮内部调查/验收失败进展；最终完成通知尚未出现。

正式Check/安装/Readback/Resume全部通过；独立回读包SHA匹配、版本1.0.0、新PID13304、health=ok、维护解除revision402、DSH Web Local Ready。未创建历史副本，原Observer保持。受管readonly重评event257/Owner154复用原Task和Owner会话，原7阶段均保持，最终业务结果待回读。

## 真实最终闭环

2026-10-03 04:51:58，原Task保持requirement5/plan6及7个成功阶段，Owner156/lease47完成。原生seq25975提交complete，25976 received=true，25978 turn completed；SQLite turn-2fdd73c6-0317-4565-bdd5-5738c6e37e66 为accepted/applied。交付manifest摘要3c66fe28552cad68be5fd4c16fc60a3eed0f656e957e1dac8d890cd91ac4d53a，complete=true、missing=[]、businessValidation.status=accepted，两项业务要求均satisfied。

本次删除工单#858/Plan879，SQL `ALTER TABLE public.process_id_temp DROP COLUMN name;`，SQL摘要07786f785d26ca9266322c8a8f309c44a2f001f992dc17b5f160b408e4f1f562。插件批准事件37748早于执行37772、成功37774，Task906/TaskRun902已完成。实际审批呈现含整列永久丢失说明，独立工单及批准未使用旧#857替代。04:53再次从生产只读副本确认目标表存在/name不存在。修复期间没有新增业务阶段、重建工单或重新执行DDL。

DWS完整群窗口由2条变为3条，仅新增04:51:58完成回复msgzG+CparmaQr10WvxIMjhJw==，引用原需求msgcwucoztLicnWwBJ+5tEu7g==；complete=true/hasMore=false/failures=[]，随后精确mget foundCount=1且正文与引用一致。内部进展未新增群消息。

单次测试heartbeat sql已通过automation_update暂停，并独立读取automation.toml确认PAUSED。私有证据：completion-contract-final-detail.json、completion-contract-accepted-manifest.json、completion-contract-native-final.json、continuous-live-proof.json、continuous-production-readback.json、completion-contract-group-before/after/exact.json、completion-contract-installed-runtime.json及同名前缀部署日志，均位于docs/tmp，不提交。
