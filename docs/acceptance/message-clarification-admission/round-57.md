# Round 57：同 Task 必要工程依赖

## 原因与实现

SG22 前端已取得候选，但真实明细下载缺少必要后端阶段。原单仓库阶段输入及线性计划只能追加末尾或重建后缀，无法保留前端等待 Run 而先完成后端；数据库唯一活动 Task 索引进一步禁止新后端 Run。

新增受限 insertDependency：当前人类来源、Host 显式依赖路径、同 UAT、独立阶段验收；原 Task 总体验收不变。原 Run 排空后以持久 stage-dependency 挂起，正式 schema 8→9 索引仅豁免此状态。后端完成恢复原原因与阶段；普通恢复扫描不得抢先重领原前端。来源、控制版本、新输入、活跃节点、未知效果仍拒绝。

新迁移脚本有独立版本与索引语义，原事件索引 7→8 脚本不适合承载，故新增专用脚本并复用其原生锁、封存、事务与全表摘要合同。未编辑业务候选、未部署、未操作现场控制账。

## 验证

- `docs/tmp/sg22-dependency-owner.log`：2/2；直接及真实 Owner 接纳/应用都创建后端 Run，完成后原前端失败节点 lease+1，generation 不变，成功准备节点逐项相同；直接路径含关闭并重开 store/controller。
- `docs/tmp/sg22-dependency-busy.log`：1/1；活跃节点、待处理输入、未知效果拒绝，原计划与 Run 未挂起。
- `docs/tmp/sg22-dependency-authorization.log`：2/2；阶段仓库与阶段验收绑定、同 UAT；无关仓库、他人来源、旧来源版本、额外目标及无验收拒绝。
- 正式迁移隔离测试：check 零写、全表摘要保持、重复幂等、重启、普通 waiting/NULL reason 仍唯一。
- 最终回归日志 `docs/tmp/sg22-dependency-regression-final.log`，结果单独读取后记入 matrix。

配置和原来源候选提案在 `docs/tmp/sg22-required-dependency-proposal.json`；它是 Owner 后续核验输入，不是人工控制账操作或业务完成证明。后端真实 API、前端修正与真实联合验收尚需原任务继续。

最终实际结果：阶段/Owner/迁移回归 **47/47 PASS**；工程授权及阶段绑定 **2/2 PASS**；Service 原工程接纳回归 **6/6 PASS**。共本轮三条最终命令 55 项通过，未将其等同于现场业务验收。
