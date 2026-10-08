# 历史错误澄清的原来源恢复

现场 #125 已明确开发目标，但旧 coordinator 澄清仍 pending、commands 为空。话题展示更新不会重新协调已消费来源。已送达通知即使核验撤回仍保留 delivered 状态，现有 reprocess 一律拒绝；复制旧 compactPolicy 又会保留过期权限指令。

复用现有 reprocess，不伪造 answer。仅新增放行：零业务 commands、通知关联当前 pending coordinator needs_clarification、通知 delivered 且 recallStatus=recalled 且非空 recallEvidenceRef、群一致。每条有外部状态的通知独立通过现有或新增检查；未知、未撤回、其他节点/已结束请求、业务命令继续拒绝。保留旧请求/撤回审计并 supersede，原 sourceKey/actor/body 保留，sourceVersion 递增。

当前服务统一构造 compactPolicy，ingest 和 reprocess 共用。仅更新策略，不接受客户端替换身份或正文。测试覆盖成功、来源保留、无虚构答复、重启持久化及拒绝反例。本轮禁止现场写入和部署。

## SG8 通知恢复必要边界

现有 prepare/execute/reconcile 增加 Host 本机 Web 身份路径，仅 explicit_user；身份来自 resident 配置，不接受正文自报 actor。授权来源以 host-web: 加编码 actor 的 authorizationRef 持久化，快照绑定通知、群、消息和事实摘要。原群负责人授权保持。拒绝非本机/非法 Origin、错身份、错摘要；重复执行不重复撤回。沿用 DWS 撤回和回读记账，不导入外部 SUCCESS 回执。
