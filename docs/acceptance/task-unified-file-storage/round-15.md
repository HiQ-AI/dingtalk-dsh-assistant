# Round 15：完成验收的 Host 顺序证据

正式 Owner 完成候选的只读重放保留失败事实：原 General 域在 30 秒预算内用时 21.279 秒返回 unverified，第 6 项顺序要求未通过；120 秒重放用时 18.597 秒仍未通过。Delivery 域用时 12.166 秒，三项未通过。延长超时不能解决已经复现的缺证据。

只读正式库证明：lease 4 仅初始化写入并应用；写入 Run 于 10:07:11.050Z 成功；lease 5 于 10:07:12.185Z 开始，随后追加投递并应用；投递前驱输出等于写入产物。lease 1–3 双阶段候选均 released，不属于执行记录。

本轮在既有内部查询提供最多 200 条已应用规划回执，在 manifest.complete 后为语义视图补充 Host 执行身份、时间、前驱及节点事实。原始 policy 输出与 general 冻结函数不改；截断规划拒绝完成。

测试先红：host-order-red-valid.log 中新查询不存在、语义证据 hostExecution 缺失。定向修复后 host-order-green.log 为 30/30。关联服务、清单回归结果另记实跑日志，完成后更新本轮记录。原生模型最终重放由主任务独立记录，尚不能把定向测试视为正式任务闭环。

最终新源码实证：由实际 createTaskWorkflowContracts 和正式 SQLite 只读 queryTaskOwner 重新生成 context 4/5（非手工 metadata），主任务使用同正式 Codex adapter、gpt-6-sol/low、原 30000 毫秒预算重放：General 21049 毫秒，7 项全部 passed；Delivery 12873 毫秒，3 项全部 passed。两域 accepted=true。结果保存 owner-domain-replay-4-30000.json、owner-domain-replay-5-30000.json；此结果证明语义证据补齐有效，不等同正式 Owner 已提交完成。

关联首轮 184 项中 183 PASS / 1 FAIL：新增规划查询遗漏当前仍合法的 appendStages 候选。已保留原生 appendStages 用例及既有断言，查询纳入已应用 advance 的非空 appendStages，来源类型原样记 appendStages，不猜 initialize/append/replaceSuffix。显式 replaceSuffix 的归一化 appendStages 不混入；无规划 advance 不进入。此为同因缺证据修复，不改正式记录。

最终关联复跑：`node --test test/task-owner-store.test.js test/task-workflow-contracts.test.js test/workflow-service.test.js test/task-delivery-manifest.test.js`，184/184 PASS，0 FAIL / 0 SKIP，100910.8744 毫秒，日志 `docs/tmp/task-unified-file-storage/host-order-regression-rerun.log`。补充无规划/replaceSuffix 排除测试后独立 query 文件 20/20 PASS，日志 `host-order-query-final.log`。原 `task-general-workflow.js` 未修改，SHA256 `1E22A7988D54D9E33883DD46E04C959F8AAEA13C66D66B6D73D0FBC8C55DBF92`。
