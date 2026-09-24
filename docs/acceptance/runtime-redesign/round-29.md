# 第29轮：消息上下文限额专项审查

日期：2026-09-24。范围：源码审查、运行账只读核对、隔离反例与方案。未修改插件源码，未部署，未发送渠道消息。

方案见 `../../spec/message-context-budget-review.md`。审查结论：需要修订，四个可执行反例均复现；不能把复现脚本退出码0解释为业务验收通过。

## 实跑

1. `node docs/acceptance/runtime-redesign/scripts/audit-message-budget.mjs`：退出码0，四项断言确认当前缺陷存在。使用真实 createMessageWorkflow/openExecutionStore，模拟 judge，无业务动作。SQLite留在本机 `docs/tmp/message-budget-audit-p4o08R`，不入库；JSON结果归档 `round-29/budget-probes.json`。
2. `node --test test/message-workflow.test.js test/message-ledger.test.js`：50/50 PASS、0 FAIL、0 skipped；TEMP/TMP 指向 `D:/dsh-test-temp`。
3. 只读 `D:/dsh_home/workflows/runtime-v2/control.sqlite`：47 个 MessageRun、31 个来源；来源最新版本为18个settled、13个superseded（outbound_echo）。当前没有最新版本的容量等待；不代表历史故障次数为零。
4. 工作区与安装包的四个消息源码文件 SHA256 相同。安装位置 `D:/dsh_home/profiles/web/node_modules/@zzusp/dingtalk-dsh-assistant`。

| 用例 | 正确行为 | 当前实际结果 | 验收状态 |
| --- | --- | --- | --- |
| BUDGET_EXPLICIT | 明确引用候选受保护 | 8个明确引用候选仅留下candidate-0至3，后4个删除 | FAIL |
| BUDGET_EVIDENCE | R补取关键约束传递给I | R看见“禁止生产写入，仅验证UAT2”，I无该证据 | FAIL |
| BUDGET_FIXED | 代码已确定产出不受模型容量约束 | judge调用0，S因22615/8000字节被拒绝 | FAIL |
| BUDGET_RESUME | 材料投影修复后原节点有恢复入口 | request已resolved，R因47310/14000字节停住，未进入容量恢复 | FAIL |
| BUDGET_BASELINE | 现有消息账和工作流回归 | 50项通过 | PASS |

## 运行样本

- `msg-replay-d68e6b28aedcf14c471332588d3cc404977e27b2`：settled。S=7,984字节/2,965 input token；R补取后=12,898字节/3,853 input token；I=10,579字节/2,757 input token。S省略列表1,563字节，R补取材料字段3,022字节。
- `msg-replay-666adbec1b2dbadb261382eb0915fa3409e09311`：settled。S=7,316字节/2,758 input token；R补取后=13,142字节/4,061 input token；I=12,960字节/3,773 input token。
- 两条均有两次R语义调用。各节点模型段耗时合计34,982ms和28,475ms，未含排队/补取等待。
- system/schema字节数：S=2,884，R=1,679，I=3,708。两条I的groupResponsibility均为4,128字节。

## 核验边界

反例验证结构和控制流，不验证模型语义正确率。现有成功节点数据含重放及不同实现时期，不是完整生产负载基准。运行账可能覆盖旧reason/失败节点，不能据此推断全日容量故障比例。后续实现须使matrix中的四项FAIL转为PASS并保留新轮次证据。
