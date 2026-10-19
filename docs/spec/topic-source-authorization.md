# 群话题续办来源校验

目标：同群真实用户明确续办已有事项时，沿原任务接纳来源，保留作者、版本和原生权限；不因作者不同于最初发起人拒绝整个话题。

现场：2026-10-19 原话题 topic-6810ca2c8cddff3f3a1585bb4f909b6b 的 task-reopen 在写入前报 TASK_TOPIC_AUTHENTICATED_SOURCE_REQUIRED。任务发起人为李辰，续办消息来自向春梅；固定消息版本存在，故不是缺来源版本，也不是部署执行失败。原任务 task-7c7b8c0d7287a6bd0de4e2a2519ba764 仍 completed，动作未应用。

根因：applyTopicAction 以 ownerActorId 过滤 basis，且再次 authorize 只接受同一所有者。与 README 授权连续性约定相悖。修正为同群、非 web/internal、带真实作者的已准入 basis；协调器仍决定是否明确交办。历史旧授权不能代替当前 basis。requester 人工答复仍只允许原请求者，其他人的补充走需求修订，不伪造批准。

恢复：原消息显式重试仅扩展上述写入前错误，复用 retryOperation 的动作、版本、已应用证据门禁；不改库、不新建任务、不重放未知效果。定向原生测试覆盖不同作者续办、同任务/session、原作者人工答复保护、旧拒绝恢复、幂等与缺来源拒绝。双包受控本地部署后独立回读话题、原任务及新增会话输入。
