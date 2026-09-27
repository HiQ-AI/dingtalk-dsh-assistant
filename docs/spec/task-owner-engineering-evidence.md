# 任务负责人读取工程验收证据

## 问题

任务 Owner 只收到阶段 finalize 的 PR 结果引用，已成功工程节点中的构建检查、本地业务验收及清理收据未列入可读白名单。Owner 因缺少真实业务材料无法完成逐项验收。不得改历史成功流程定义或人为补写验收结论。

## 修改

在 Owner 快照层复用 readEngineeringDeliveryProof，验证成功工程 run 与本任务、冻结定义、candidate、commit、本地验收计划/结果、cleanup 的完整一致性。对已验证 proof 中的 verify-candidate、define-local-acceptance、finalize-local-acceptance（旧版 business-acceptance）节点追加带用途标签的真实引用，保留阶段原最终产物。只读既有不可变节点工件，不新建“通过”摘要、不改变 workflow digest、不重跑成功节点。节点引用用于读取明细；completionEvidenceRefs 保留正式阶段可提交引用，提示 Owner 的 assessments 引用它，保持 Store 原完成白名单不变。现有 artifact 工具及 64KiB 限额、8 步默认不变；当前真实三个证据工件分别约 3KiB/6KiB/7KiB，三个阶段加三证据及决定可在默认步数内完成。

## 验证

扩展既有工程证明测试，确认产物可读引用、明确标签、只选择已核验节点、最终产物绑定；错误 task/run、候选或清理失败继续拒绝。部署后需原生唤醒 Owner 重新读取证据，自主提交逐项验收，不能写库完成。
