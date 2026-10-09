# 第35轮：内部故障不转成业务确认

通知检查原先先看本轮继承的 workflow.confirmation.required，再判断当前 wait/block 条件。工具缺失或执行故障若同轮带历史审批事件，会误发“需要你确认”。现在先按当前报告条件判断：business-input、permission 保留必要用户行动；capability、execution、approval 不因历史触发事件绕过原有静默规则。未新增状态或审批入口。

真实控制账与原生通知领取定向11/11 PASS（2383ms），覆盖十种wait/block与历史审批触发组合、已准备通知的领取复核，以及repair负例；日志 docs/tmp/clarification-tests/internal-block-notices-final.log。未把测试等同消息现场验收。
