# Round 41：工程同代检查续行与共享材料读取

本轮不部署、不操作线上业务、不改全局 checks profile。

## 实现与证据

- registry/controller/store 的 checks checkpoint 仅在 exact maintenance id/revision 且全局排空下接纳。原 Task、Run、generation 和成功前缀保留；检查定义更新并审计旧新 digest、输入与证据；不调度，仅将原验证节点 ready。现有全局 profile 需等旧非终态任务完成后再修改，见部署 runbook。
- 工程工具 materials 复用现有 Task work/tmp/outputs、SHA 工件与共享索引，读取当前及明确标注历史的材料/产物，不向节点逐级复制正文、不变 generation。
- 已知不准入仓库路径返回 scope_denied 和 list 提示；../仍拒绝。工具提示先读完整材料，不能把未读材料当作 no-change 成立依据。
- 实时只读 task83c 证明 reference 实为 execution_tool_failed，原生 session97c9…最后79工具调用、80唯一精确路径错误、81step/end、82turn/end blocked。严格复用原生最后本轮身份/lease/无提交/无新输入核验，仅此精确错误重分类为 ENGINEERING_READ_PATH_INVALID，再沿 Owner node.resume 同节点同代续行；通用run.recover拒绝绕过。

## 本轮实跑

TEMP/TMP 均为 D:/t。

1. `node --test --test-name-pattern='工程检查checkpoint|检查checkpoint Controller|工程旧越界|工程共享材料|历史scope|历史中断|工程检查缺文件' test/execution-store.test.js test/execution-controller.test.js test/workflow-engineering.test.js test/execution-session-native.test.js test/task-workflow-contracts.test.js`：13/13 PASS，`docs/tmp/checkpoint-final-targeted.log`。涵盖maintenance/revision/control/范围/排空/节点方案拒绝，同代验证、旧泛型失败重分类续行、历史材料和outputs读取、旧定义可恢复。
2. `node --test --test-name-pattern='工程空方案重发' test/workflow-engineering.test.js`：1/1 PASS，`docs/tmp/checkpoint-scope-read.log`，含package.json scope_denied和../拒绝。
3. controller整文件63/63 PASS，`docs/tmp/checkpoint-controller-regression.log`；其后新增路径由第1组覆盖。
4. engineering+contracts整文件52项，51PASS/1FAIL：`docs/tmp/checkpoint-engineering-regression.log`。既有“工程交付后补充”在read-files遇ENGINEERING_REMOTE_READ_FAILED；独立重跑 `docs/tmp/checkpoint-existing-rerun.log` 已1/1 PASS（169882ms）；保留首轮失败与复验记录，不覆盖原日志。最初长TEMP导致Filename too long已改短TEMP，亦未冒认通过。

本轮源码和定向证明与现场业务恢复、构建成功、部署分开，后者由主代理按受管维护流程核验。
