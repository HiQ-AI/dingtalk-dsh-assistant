# 第二轮：反例审查与夹具订正

独立审查用真实隔离账本证明：已建立提醒通过 schedule-change 改期后，旧 prepared 确认仍能获得发送许可。修复仅限来源接纳通知：回读持久 acceptedProposal，初建 schedule 或 resolve 创建的 schedule 已超过初版时，退役旧 prepared 确认；query、control 和 occurrence 通知不套用此规则，已开始/未知发送仍沿原身份对账。没有改写历史通知 payload。

恢复路径增加 notification.get：已冻结的通知不以新版回复模板重新准备，避免升级后相同幂等键对应不同正文。测试保留原文本与原身份，恢复不再申请准备。

逐条读取真实提案还发现 interpretation 包含“由Host判断补执行窗口”等内部说明；不能因结构通过就把它作为用户回复。提醒接纳正文改由已验证 rule/timezone/reminderText 生成，测试明确拒绝在回复中出现 Host、内部订正和补执行说明；模型语义不变，无需重跑真实模型。

本轮测试修订保留两次夹具预期错误：重启后的 starting 按既有合同变为 unknown；部分明确安排恢复时可以正常生成独立聚合摘要。断言分别改为核对 unknown 无新发送许可、精确回读原接纳通知，而不是错误禁止正常聚合。

真实模型第7例第二次调用结构通过，但复核发现 fixture 使用 scheduleId / target.groupId，生产返回为 id / target.conversationId。该次结果保留并标为无效，不能作为最终通过证据；仅修夹具后重跑该例，前六例不重复调用。见 [第二轮提案及无效原因](round-2/model-results.json)。

测试映射检查首次提示 test_suite_map_stale，原因是通知扫描测试新增原生 Host 导入，分类由 compat 变为 native，并连带调整后续轮转 lane；使用既有 update 重新生成，需确认文件全集、release 和历史保留集合不变。
