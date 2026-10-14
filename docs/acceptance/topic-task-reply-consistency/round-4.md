# 真实部署与原消息恢复发现

原生部署成功：旧 PID 19072 正常 SIGINT 退出，正式脚本核验 owner/原生回合排空，无备份、无 schema 迁移；新 PID 44876。安装依赖独立回读指向 round-3 的精确双包，收信与 DWS bridge 正常。

通过现有原消息 retry 入口恢复后，真实任务的原人工请求转 answered、新增原回复来源、相同 task/session 转 running，原两次执行保留。但话题决策停在 `outbox_identity_duplicate`，因此本轮恢复 FAIL，不能仅因健康 ok 或任务运行声称话题已结清。

根因：旧版提前送达的回复已由 projectTaskNotification 将 sourceMessageId 改写为 task-notification 身份；appendOutbox 仅按旧 sourceMessageId 去重，重建相同 outboundId 被替换图唯一性校验拒绝。追加修复沿 outboundId 核验原正文/决策/引用后复用。原生 prepare 命令重放时还须回读当前通知，避免旧收据的 prepared 快照覆盖 delivered 缓存。

新增回归模拟旧版先发送后来源拒绝、第一次恢复动作应用但回复身份重复、第二次显式恢复沿原回复收口；核对零重发、原送达 ID 保留、同账号回声仍被识别。另验同 outboundId 正文/决策/引用冲突拒绝。3/3 定向用例通过；最终整组重跑和第二次部署另记 round-5。
