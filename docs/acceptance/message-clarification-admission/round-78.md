# Round 78：Owner 本地验收配置与依赖接线

## 范围与状态

Owner 原生工具 schema、当前回合提示及 Store 决定合同接通 `workflowRevision.localAcceptanceProfileDigest`、`nodes[].dependencyBindings`、`nodes[].previousOutputNodeId`。配置从 Host 已登记的本 Task/UAT/需求摘要能力选择；Host 保留真实前驱职责和输出合同核验，同依赖不可同时使用 dependencyArtifacts；resumeCurrent/settleManagedCandidate 与配置或节点调整互斥。

本轮仅源码和隔离测试。记录时新源码尚未安装，未发送群消息、未修改现场任务、未提交；不等同业务完成。Round 77 部署摘要保持原样。

## 首次失败（保留）

日志 `docs/tmp/owner-local-wiring.log`：5例中4 PASS、1 FAIL。current service fixture 使用固定 `slice(1)` 构造后缀，错误包含已成功的 define-local-acceptance，真实 Host 拒绝 `ENGINEERING_REVISION_NODE_DUPLICATE`。随后改为按当前 plan-local-acceptance 真实节点位置取后缀；没有放宽 Host 重复节点门禁。

## 实跑通过

```powershell
node --test --test-name-pattern '动态流程数据合同|缺修订参数|Owner经真实service' test/task-owner-store.test.js test/task-owner-session-native.test.js test/workflow-service.test.js
```

日志 `docs/tmp/owner-local-wiring-final.log`：5/5 PASS，15223.6161 ms。

- 原生 Owner 工具同回合纠正缺参数后完整提交三个新字段。
- 真 Owner controller → workflow-service → task-workflow-contracts → registry 应用：选择已登记 profile，重命名规划节点，接入 dependencyBindings/previousOutputNodeId；新 workflowDigest 生效，同 Run/generation 及成功前缀保持。
- foreign Task 与旧 plan 诊断证据继续拒绝。

补充无效 digest、互斥动作、同 key 双依赖反例后再跑：

```powershell
node --test --test-name-pattern '动态流程数据合同|缺修订参数' test/task-owner-store.test.js test/task-owner-session-native.test.js
```

日志 `docs/tmp/owner-local-wiring-negative.log`：2/2 PASS，472.9297 ms。

全部命令仅当前进程 TEMP/TMP 指向 `docs/tmp/clarification-tests`。service 用例模型输出为确定性 fixture；Store、领域合同、registry 和 controller 为实际实现，未用接受回调替代领域应用。完整候选本地验收交付链由工程用例另行验证，本轮不宣称真实模型或线上验收通过。
