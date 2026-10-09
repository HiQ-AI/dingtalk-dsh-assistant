# Round 79：Task 场景重选与真实工程依赖重规划

## 结论

插件接线已冻结。错误旧验收配置 → 新增同 Task/UAT/原需求摘要的正确 Host 配置 → 重启 Registry/Controller → 同 Run/gen 插入新 define/plan → code 节点读取新计划及原验证候选 → 真实本地验收、清理、Git commit/push 与 PR 读回成功。未部署、未写现场业务控制账；当前真实任务尚未完成。

## 实现边界

- `workflow-engineering.js`：`localAcceptanceProfileDigest` 仅选择 Host 登记且精确匹配 Task/UAT/requestDigest 的完整配置；模型不提供命令。
- `dependencyBindings` 与 `previousOutputNodeId` 只映射严格前序节点，原职责模板和输出 schema 必须相同；执行原 mapper，不接收代码/伪数据。成功前缀及效果保留。
- Task 配置目录不再进入新 repositoryDigest；旧定义只允许精确当前 legacyDigest。旧冻结 runner 不变。与停机前检查同步由 root 完成。
- 新副本重新构建工厂后 prepare-commit 会真实复验；最终证明接受同候选、相同检查 id/version、真实全部通过且摘要匹配的复验，绑定最新提交证明。伪候选/失败检查/换检查拒绝。

## 实跑证据

1. `node --test --test-name-pattern '真实工程本地重规划' test/workflow-engineering.test.js`：1/1 PASS，77.8 秒。`docs/tmp/local-revision-real-profile-corrected.log`。真实 Git/本地服务/进程清理、真实检查子进程、Git push，PR 使用明确测试 adapter。断言原 Run/gen、成功前缀 outputRef/lease 不变；新定义 queued 阶段 restore digest 一致再 recover。
2. `node --test --test-name-pattern '工程交付证明复用' test/workflow-engineering.test.js`：1/1 PASS，`docs/tmp/local-revision-delivery-negative.log`；含新副本复验成功及三个伪证明拒绝。
3. `node docs/tmp/check-active-registry-restore.mjs`：现场一致只读账，5 个活跃原定义摘要 5/5 相等（v18 四个、v19 一个），不派发。`docs/tmp/local-revision-active-restore-proof.json`、`local-revision-active-restore-final.log`。
4. Owner/schema/service 全链由另一 agent 验证，记录 round 78，不能把此处直接 registry 测试代替该层。
5. UI runner prepare/serve 参数边界 4/4：`sg22-ui-host-contract-final.log`。隔离历史修正 fixture 的真实 HTTP 服务、assets、命名空间、拒绝外部监听/POST：`sg22-hosted-ui-test-rerun.log`、`sg22-hosted-ui-proof.json`。这不是当前候选业务验收，不证明后端。

## 保留失败轮次

- `local-revision-real-flow.log`：第一次发现重新构建工厂的真实复验摘要变化，旧交付证明误拒。精确证明修复后 `local-revision-real-flow-rerun.log` 1/1 PASS。
- 强化为旧错误配置切换后 `local-revision-real-profile-final.log` FAIL：fixture 重建 registry，却给 controller 旧 registry 的 deliveryOptions，产生 `LOCAL_ACCEPTANCE_PREPARED_MISMATCH` / `DELIVERY_RECONCILIATION_REQUIRED`。修为真实生命周期重新组装 adapter，未放宽产品对账。
- `local-revision-real-profile-lifecycle.log`：完整流程已 succeeded，最后测试错误要求 restore 返回终态 Run；产品按合同跳过终态。将摘要恢复断言移到 queued 后、recover 前，最终 PASS。没有缩减真实交付断言。
- `sg22-hosted-ui-test.log`：历史 fixture 依赖 junction 指向已清理旧目录，MODULE_NOT_FOUND；另建 docs/tmp 隔离 fixture 复用现存依赖后 HTTP 服务验证 PASS。不改业务候选。

## SG22 真实交付仍缺项

`docs/tmp/sg22-ui-host-profile/proposal.json` 是 partial UI 草案，readyToApply=false：旧 harness 父实例使用旧字段，当前 gen7 使用 activityMergeResults/handleActivityMergeResult，必须适配实际实例字段后才登记。固定 backendVerified=false，不能替代 Excel 15 列、服务端状态/权限/版本校验。后端依赖 Run `run-b7198615cd06723b2ee9b443f3f99290308a52000399e5876e6ca055dc2e2867` 由原 Task 正在实施；不自行定接口或改业务代码。正确 profile 的 exact scope 与内容寻址工具草案均已留 docs/tmp，见部署说明。
