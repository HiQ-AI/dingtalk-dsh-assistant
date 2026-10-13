# 第四轮：关联修复与首轮回归

2026-10-13，基于已合并 PR #159 / origin/main 1cd06d2，按 task-session-step-associations.md 实施四项关联修复。正式运行数据未变更。

## 审查基线

- 直接任务会话完成：Service 返回 completed/succeeded、已绑定 Owner、零流程，但旧页面显示步骤待确定且无 Owner 入口。
- 模拟 Agent 会话创建失败：节点 sessionBound=false 仍有预分配 ID，旧页面生成跳转按钮。
- 真实 v25 registry.updateCheckpoint(checks)：4个成功前缀节点、产出和会话完全保持，但旧 stepKey 全部改变。
- 浏览器选择步骤1后切群消息再刷新，回详情变为默认步骤6；不切页刷新及切页不刷新两个反证都保持步骤1。

基线脚本及结果保留在 docs/tmp/task-detail-review/：session-review.test.mjs、session-review.log、identity/reproduce-checkpoint.test.mjs、identity/result-checkpoint.json、ui-probe.mjs、ui-results/ui-review.json。归档临时复现不入库，正式回归已并入现有测试与浏览器脚本。

## 首次实施结果

- Observer 定向测试33/35通过。两个失败来自原测试没有提供新增 latestReading 引用，以及会话 fixture 缺少 sessionBound；日志 docs/tmp/task-detail-review/ui-unit-first.log。未删除原断言，后续补真实行为回归。
- Service 定向回归8/9通过。新增替换阶段 fixture 未先 advanceTaskPlan 收敛完成态，合法控制器拒绝 TASK_STAGE_STILL_RUNNING；下一轮按真实流程先收敛完成阶段。
- 本轮不作为全绿验收。修复后验证另记下一轮，不覆盖这些失败。
