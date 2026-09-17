# 第六轮：单消息多事项与独立反馈

日期：2026-09-17。

## 实现结果

- 路由协议从“消息对应 Topic”扩展为“消息包含 units，unit 分别关联 Topic”，服务端原子校验来源、背景、忽略范围和动作 owner。
- Topic、Decision、Task、Outbox 的消费与来源身份改为 `unitId + unitRevision`，固定旧版本仍可读取。
- Task 叶子仅接收自身事项原文和背景；兄弟事项共享 messageId 不再造成动作授权或回复候选串扰。
- 事项完成通知冻结当时已接收入站边界，边界外后续消息不延迟旧通知；Task 重开或结果过期会使待发 Outbox 失效。
- domain version 升到 8，迁移工具提供明确 v7→v8 路径并保留 Task、Decision 与已发送 Outbox 身份。

## 验证

- `node docs/acceptance/topic-driven-processing/scripts/reproduce-message-multi-topic.mjs`：4/4 PASS。覆盖 #1066 三事项三 Task、兄弟事项不互相消费、A 完成不等待 B/C、长消息读完前拒绝原子提交、同消息复核不能更换 unitKey 重授执行权。
- `npm test`：400/400 PASS，0 fail、0 skipped。
- `git diff --check`：PASS；仅报告 Windows 行尾转换提示，无空白错误。

## 证据边界

- 本轮为真实 Store/Coordinator 与隔离内存/临时存储验证，没有连接 DWS，也没有修改实际 profile。
- 冻结 gold 已落盘，但尚未用生产配置模型执行，所以没有语义误拆率、漏拆率、错误续接率和授权扩大率。
- 详细清单缺口见 `checklist-audit.md`；未实现项不会被 400 项结构和行为测试覆盖结论替代。
