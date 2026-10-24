# 发信箱取消状态与证据优先级

## 问题与目标

2026-10-24 现场只读查询两个群的发信箱共 151 条记录：147 条 delivered、2 条发送前拒绝、2 条 superseded（coordination-source-resolved）。现有 Observer 不识别 superseded，将订正后未发送的旧确认显示为“待确认”；已正式停止的通知又被归入“异常”。本轮补齐“已取消”，同时梳理显示、原因与筛选的一致性。

## 现状与方案

- 唯一 UI 映射继续使用 `web-client.js` 的 `outboxDelivery`；复用现有 Pill、SelectMenu、四列表格和 `docs/manual/observer-design.md` 的主题约定，不新增组件体系。
- 公开状态统一为待发送、发送中、待确认、已送达、已取消、异常。取消表示已确定不会再发送的本次通知，不表示撤回已经发出的消息，也不表示业务任务完成。
- 当前通知账已有 superseded；不新增持久化生命周期或迁移。`taskNotificationOutbound` 从无 ACK/回执、无发送许可的失效通知，或严格 knownNotSent 的正式终止记录，投影未发送事实及清楚的原因。
- 已送达事实优先于替代关系、旧错误和撤回。starting/unknown 不因安排取消或被替代而显示已取消。历史仅有 superseded、但没有可靠未发送或送达证明时继续待确认。
- confirmation-reassessment-required 仍显示异常并说明关联需要核验；可重试的发送前拒绝仍是异常。取消记录不显示重试或核验计划。内部原因与原始错误保留于折叠诊断。
- 若兼容工作流的 notificationStatus 出现在发信箱，展示适配其 prepared/sending/acknowledged 等事实，避免错误落入无状态历史分支；不改旧账。

## 验证与交付边界

在既有 `docs/acceptance/outbox-delivery-status/` 追加第八轮，测试真实投影与 UI 分类、六状态筛选、未知与送达反例、取消原因、撤回独立呈现。复用现有无外发浏览器脚本并更新陈旧断言，检查桌面、窄屏、键盘操作与刷新。相关回归及 release smoke 通过后交付新 PR。若部署本地，按原生运行指引执行 Check、包摘要/新进程/健康和真实发信箱回读；测试不发送、撤回或改写业务通知。
