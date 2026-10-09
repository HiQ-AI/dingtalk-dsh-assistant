# Round 73 — SG19 保留既有编辑的原方案纠正

## 结果

本轮修复原生 node.resume 的候选保留准入与执行合同的额外证据范围。未部署、未写现场控制库、未修改业务仓库；三个开发任务没有因此被宣称完成。

- `docs/tmp/sg19-proposal-final-tests.log`：12/12 PASS。覆盖原纯校验纠正、重复相同问题拒绝、foreign workflow/暂停/维护，以及真实审计形态下保留两成功编辑、失败编辑拒绝、外来审计拒绝、lease 漂移拒绝。
- `docs/tmp/sg19-contract-evidence-ticket-final.log`：31/31 PASS。当前原需求/候选工件/原生 Host 反馈可沿实际合同接纳；外 Task、旧 requirement/plan/control、无事件登记及缺必需诊断拒绝；原领域准备票据验证仍执行。
- `docs/tmp/sg19-proposal-snapshot-proof.json`：当前 SG19 一致性控制库副本原生 node.recovery 返回 repairable=true，原 inspect lease3 / validator lease3 身份保持。
- `docs/tmp/sg19-native-correction-proof.json`、`sg19-native-correction-controller-final.log`：实际原控制库复制、真实 registry 定义恢复、真实 Controller/Task contracts 观测到 resume-agent，原生 resume/claim/drained/commit；隔离 Git 候选复制，原 v18 validator 先拒绝真实等值 replacement，脚本模型 fixture 读取现文件后返回 no-change，原 managed-tree proof 核完整候选，再进入原 verify ready。原 Task/Run/generation、会话、四成功前置节点和两 edit 效果完全保留，效果列表前后深相等。没有新编辑。

真实候选树为 `b5db04e8a2cc08f363c57cef38ae6c7295db15f6`。本轮只验证恢复到真实验证入口，未运行该业务的 Maven、后台或交付验收；fixture 的模型输出是显式脚本，不是云模型结果。

## 根因与改动

真实审计 43204 已按 candidate-in-place 保留两成功编辑并失效后继 input/output；旧恢复逻辑把这些 blocked 非零 lease 与成功效果当作新执行，阻断原 Agent 修正等值条目。worker 只接受同 Task/Run/generation/workflow/requirement 的原生审计和精确旧 lease；编辑例外只限 apply-changes 的全部 succeeded edit 及旧输入/输出身份。未知/外部效果不删除、不重派。

Owner 已允许额外已读当前 Task 事实，但 contracts 第二门禁只认失败工件，造成同一合法决定到服务端再次拒绝。现复用 Owner 当前 stageArtifacts 投影和原生 system.recovery 当前版本校验；必需失败诊断仍完整保留，特殊领域查询仍按原合同验证。

## 迭代记录

首次隔离脚本语法缺大括号（`sg19-native-correction.log`），修脚本后实际链通过。新增真实 Controller 门禁时先暴露 fixture 未接 delivery、readTools（两个 controller 日志），接入实际 registry deliveryOptions 与受信定义工具清单后通过；没有放松产品门禁。首次 contracts 31例通过后又补准备票据复验路径，最终31例再次通过。历史日志未冒称首轮全绿。
