# Web 当前阶段确认

现有 Web 来源任务仅能补充与取消，无法解除 confirmation 阶段门禁。本次增加正式 `confirm-stage` 接纳，复用受信本机 actor、耐久 Web 事件与原生阶段确认；不伪造 IM，不修改冻结工程定义。

请求绑定当前 Task 的 requirementRevision、controlRevision、planRevision、stageId、前序 outputRef、runSequence，并保存用户确认正文。接纳事务及应用事务都校验版本；只允许当前等待确认阶段。重复请求读回原命令回执，内容不同冲突。确认后发布 approval.resolved 事件唤醒 Owner，后续仍须 Owner 明确推进，不自动确认其他阶段。未完成与未知外部效果、过期/跨任务/未来阶段均不得借确认跳过。

验证覆盖真实 HTTP/服务与控制账：合法确认、幂等、请求冲突、错误 actor/来源、过期要求与计划、跨任务/未来阶段、确认后重启恢复，以及后续阶段仍未确认。
