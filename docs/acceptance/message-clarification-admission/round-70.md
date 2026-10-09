# Round 70：Owner 失败反馈与实际证据准入

## 结果

Owner 相关联合回归 101/101 PASS；最后补充原需求引用可读绑定及原应用状态审计后，原生重点回归 8/8 PASS。没有部署、现场写入或发送消息。原生测试使用真实 DSH AgentLoop、会话持久化、工具、SQLite 与执行控制器，模型为脚本 fixture；真实云模型结果由 round 72 单独记录。

## 修改

- 所有 repairCurrentStage 模式均可引用本轮实际读取、当前 Task 快照绑定的阶段产物/原需求。system.recovery 的 owner-action-failure 还须同 Task、当前 requirement/plan/control 版本。必需 currentExecution 诊断与 resume-agent 的精确 failure/binding 核验保持；未放开任意工件。
- nodes[].dependencyArtifacts 数据合同可由原生工具提交，映射原依赖节点到真实 artifactRef；领域 Host 继续核同 Task/Run/generation 成功产物。
- 旧 accepted/application_status=blocked 决定由现有 Owner 队列扫描取回，直接生成完整可得诊断、原决定、当前计划、回执与 effects，再经 action.fail 封存并唤醒原 Owner。旧版只有持久错误码时明确说明缺原调用栈，不伪造旧错误细节；不会再次应用旧决定，不需要人工 retry。已 applied 决定保持 applied 审计；暂停/取消保持 idle。

## 实跑

```powershell
$env:TEMP=(Resolve-Path docs/tmp/clarification-tests).Path
$env:TMP=$env:TEMP
node --test test/task-owner-store.test.js test/task-owner-recovery.test.js test/task-owner-session-native.test.js
node --test --test-name-pattern='原生Owner动作应用未知错误|原生两轮流程修订|未决真实效果' test/task-owner-session-native.test.js
```

- 联合日志：`docs/tmp/conversation-owner-round70-final.log`，101 PASS，0 FAIL，9431.7 ms。
- 最终原生日志：`docs/tmp/conversation-owner-round70-final-native.log`，8 PASS，0 FAIL，4549.4 ms。
- 原生两轮：应用失败反馈后，模型读取完整反馈及原 prepare 产物，提交另一策略，原 Run 成功且成功前缀 lease 不变；workflow-revision 和 resume-agent 均通过。
- 反例：额外诊断跨 Task/旧 plan 版本拒绝，未调用第二次修复；必需失败证据仍核验。
- 旧 blocked 通过真实旧 action.fail 命令构造（无裸 SQL 修改），原生自动回收后原会话推进成功；重复扫描未再次应用旧决定。
- 真实 delivery unknown 效果维持原账且仅发送一次，Owner 新派发被同轮反馈阻止，改为等待原效果对账。
- `git diff --check` 对本轮 Owner 源码/测试通过。

## 保留失败证据

`docs/tmp/owner-blocked-store-initial.log` 留存原测试仍断言 blocked 不可见的失败；更新为新诊断回收合同。`docs/tmp/conversation-owner-round70.log` 留存负例预期 NO_DECISION 与真实 REPEATED_INVALID_DECISION 不符的测试失败；随后改为精确实际拒绝合同再验证。未覆盖 round 69 真云失败。
