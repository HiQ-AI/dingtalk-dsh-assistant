# Round 50：SG20 候选纯校验原地纠正

## 根因与实现

真实83c原Run generation4在validate-proposal等待ENGINEERING_NO_EFFECT_MODIFICATION。原提案13条替换中11条有变化、2条from===to；不是“候选全部没有有效改动”。冻结校验正确拒绝，原恢复只接受失败agent，遗漏了紧邻纯validator退回已提交agent的路径。

复用inspectNodeRecovery/node.resume，四类明确候选语义错误可返回原inspect-and-propose。保留Task/Run/generation、input/session和成功前缀；原提案/validator输入与失败证据保存在正式恢复事件。仅原agent纠正及validator重验，validator lease不归零。不修改冻结工厂，不替模型删项，不动运行业务workspace。来源/控制/CAS/排空/无下游效果原门禁保留；Controller另核冻结validator纯效果及其输入等于原候选。普通run.recover不得绕Owner，同problemKey不无限重试。

## 验证

- controller整文件：73/73 PASS，docs/tmp/sg20-controller-regression.log。8个新增定向包括原地成功、重复错误拒绝、非纯validator、非工程、暂停、维护、方案文档与no-change证据。
- 原生JSONL已提交候选同会话lease2纠正：1/1 PASS，docs/tmp/sg20-native-correction.log；旧提交历史前缀不变，新请求包含原提案与纠正策略。
- 真实control.sqlite用SQLite原生backup只读复制，随后仅隔离副本运行新worker：repairable=true，nodeId=inspect-and-propose，generation=4，2条证据。docs/tmp/sg20-copy-predicate.log。隔离库已精确迁至docs/tmp/sg20-copy-X2mVPQ/control.sqlite，未写现场库；脚本后续默认输出docs/tmp。

源码：execution-store-worker.js、execution-controller.js、execution-recovery-policy.js及对应测试。README和部署runbook同步。未提交、部署、恢复线上任务；实际Owner续行由主线程执行并独立回读。
