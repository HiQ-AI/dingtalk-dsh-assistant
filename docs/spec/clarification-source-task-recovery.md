# 原文澄清关联与任务创建恢复

## 现场与目标

#124仅点名却产生了“评审/排查/开发”的澄清。相同作者随后#125明确“按文档开发”，协调器已接纳create，但旧pending unit令task.accept拒绝，命令被记为unknown/MESSAGE_INPUT_PENDING。目标是原文来源可追溯地解除旧等待并恢复同一个taskId的创建，独立读回任务发起。

## 受管修复

复用control store、artifact、维护和本机Web身份链。在封存排空维护下，check零写回读当前request/source/topic/command，确认原答复同群同话题、同permittedActor且原occurredAt晚于问题来源；仅needs_clarification，不能处理授权请求。原create须unknown/MESSAGE_INPUT_PENDING、当前版本，Task/Owner/Run及业务效果均未落地。返回摘要和原文快照。

apply按同摘要事务重验，将旧请求以已有答复的真实作者、来源及正文resolved，旧unit标已处理并保留审计；不删除coordinatorConsumed，避免重新创建事项。原create恢复pending，保留原taskId/lease和恢复历史；不制造用户消息、不写假Task、不重发或撤第三条通知。artifact记录Web维护操作者和原文答复人，二者不能混淆。恢复后使用现有派发及Owner创建任务。

## 验证与边界

Ledger正反例覆盖同作者正确答复、跨作者/话题/组、旧版本、摘要漂移、错误状态、已有Task/效果、未维护等；service/HTTP核验身份注入、dryRun零写与重复请求。未来消息路径优先使用已有clarification动作，避免只create而忽略当前澄清；与现场受管修复分别验证。所有变更保留授权门禁，恢复既有交办不代表业务开发完成。
