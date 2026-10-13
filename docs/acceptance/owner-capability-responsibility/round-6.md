# Round 6：候选校验反馈导致执行中断

## 现场根因

原 Task task-ac23cf259473d9300bb0a0a8310c2bd0 的 Owner blocked，revision=21、lease=8、last_failure=TASK_OWNER_CORRECTION_LIMIT；Task仍pending/active。

原生日志提交seq10182、11119、12158、12831的condition.evidenceRefs分别有1、2、3、2条不在decision.evidenceRefs中。kind均为合法值，三个文本字段非空且未超过2000字，排除字段缺失/长度作为这四次错误的解释。前三次被笼统CONDITION_INVALID拒绝，第四次触发纠错上限。之前设置的完全权限未回退。

保留证据子集约束和有限纠错，不自动补写候选；具体失败反馈应指出不在主证据列表中的引用，让原会话自行修正。现场原始材料位于原生日志；复核摘要在docs/tmp/owner-condition-failure-proof.json，可从上述seq重新生成。

## 验证

待定向测试、部署及原会话恢复后追加真实结果；不代做UAT验证，不宣告业务完成。

- 定向测试：native suite 66/66 PASS；store suite 48/48 PASS。新增真实SQLite worker到AgentLoop路径验证精确缺失引用反馈、同轮修正及最终accept；保持原纠错上限和证据约束。部署Check零写通过，包SHA256 ffa01af055a3ecfaec587e1cd6223a0fb205826ee5c49d74bf0b3944c0d26731。
