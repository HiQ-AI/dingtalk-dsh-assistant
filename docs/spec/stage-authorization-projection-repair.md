# 阶段授权投影受管修复

当前 canonical Task 保留 #114/#115 原文，但 stageAuthorizations 仅含没有 objective/gate 的 #114 全文项。外部阶段匹配把缺 objective 当通配，并未强制 #115 的测试后原发送人验证条件。

本轮只修授权投影：外部项必须明确 objective/gate 并精确匹配；旧缺字段项不授予外部执行权，原文仍保留。新增仅本地身份可调用的修复入口，从现有 requirement.sourceInstructions 的当前来源验证 sourceVersion、actor 与正文摘要，逐字验证候选 sourceQuote/objective。候选使用本轮真实 IB 已通过的 #115 两阶段授权，不添加业务要求，不用李辰确认替代 #114 的人工审批。

修复仅替换 stageAuthorizations，其他 requirement 字段保持一致。写新的不可变 artifact，并通过现有 requirement update reducer CAS 增加 requirementRevision；固定 authorization.projection.repaired 事件记录 old/new ref、reason、来源摘要。保留 Task 身份、旧计划、失败、执行与通知账；不伪装用户补充，不重放原消息。

提交事务再次校验原 requirement ref/revision、来源正文 hash/actor/version。仅允许已有执行均为只读调查且无 running/unknown、未排空节点或任何 effect，Owner 不在途；不允许借此修复包含外部执行的 Task。重复 repairKey 同参数回读原 receipt，不重复更新。

验证覆盖：严格匹配拒绝缺字段/错gate；修复只改授权且同Task/原失败保留；来源漂移/CAS/在途或外部效果拒绝；同key幂等与异参冲突。无真实库写、无部署、无备份。
