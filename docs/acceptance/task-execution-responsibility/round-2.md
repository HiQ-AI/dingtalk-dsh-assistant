# 第二轮：完整诊断、终态扫描与无进展旁路

日期：2026-10-13。

## 修正与证据

- 通用恢复上下文内嵌全部准入 evidenceRefs 的真实正文，并逐项与工件回读 deepEqual；无工程工具的 Agent 也能取得原始 schema 错误 message/phase。
- 恢复列表新增显式 includeFailed，限制为当前活动任务、当前运行/阻塞阶段；默认 activeOnly、归档、暂停及终态历史行为保持。Service 仅对已准入 failed 执行续行。
- `round-2/service-regression.log`：Service 的暂态/外部效果/PR/provider/观察/暂停/关闭回归23/23 PASS。
- 完整三文件首轮286项中283通过，3处旧预期失败。其中2处预期 Owner 手动恢复已改为 Controller 受管恢复；第三处证明 no_submission 同问题可从底层 run.recover 绕过 node.resume 保护。已增加持久事务门禁 NODE_RECOVERY_REQUIRES_CONTEXT，不改变数据库结构。`round-2/no-progress-tests.log`：3/3 PASS。
- `round-2/recovery-tests.log` 的归档夹具曾失败 TASK_CONTROL_CONFLICT：blocked stage 正式 pause 后直接为 paused，不应再 settle；夹具改为读实际控制态和版本。修复后的3项定向（两类重复问题+归档）PASS，最终组合结果记第三轮。
- 独立二次源码审查：未发现新阻断。原节点身份、当前需求/计划/控制版本、来源、效果和任务暂停仍由原事务重验；提示不扩大工具权限。

## 边界

原生会话使用脚本化 Provider 验证会话/工具行为，不代表真实模型质量。没有部署、钉钉发信或操作真实任务。
