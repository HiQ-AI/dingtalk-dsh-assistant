## 问题与结果

既有运行看板缺少协调账本入口：用户看不到未接纳输入、已保存的安排判断、任务前置依赖及正式完成证明。本 PR 在原看板加入“协调工作”，通过真实 resident 只读 HTTP → task service → SQLite 查询链展示这些事实，不另建应用、不推测内部思维过程。

基于最新 `origin/main c23a39a`（已含 PR257），仅修改独立 `worktree-coordinator-work-visualization`，没有接管旧协调顺序验收，也没有覆盖主检出的用户未提交文件。

## 实现

- `packages/dingtalk-dsh-assistant/coordination-observer.js:18`：独立只读白名单投影，source-driven 列表保留 reserved/rejected/clarification；复用权威 `coordinationSnapshot`，先计算完整聚合再限制详情集合至最近 100 条，显式报告截断。
- `packages/dingtalk-dsh-assistant/http.js:264`：增加列表和来源详情 GET，群组筛选及 offset/limit 分页；非法参数 400、缺失来源 404、读取异常 503，不暴露原始诊断。service/resident 原生接线，无命令能力。
- `packages/dingtalk-dsh-observer/web-client.js:532`：协调记录独立每 5 秒轮询，AbortController、请求范围 identity 和 cleanup 隔离迟到响应；同范围失败保留旧数据并明确过期，切换范围不沿用旧内容。
- `packages/dingtalk-dsh-observer/web-client.js:556`：复用原生按钮、菜单、状态与主题；展示记录的判断/依据/限制、依赖、等待阻塞、定时执行和送达事实，可打开原任务详情再返回来源。已接纳不等于完成，历史证明不证明当前版本完成。
- `packages/dingtalk-dsh-observer/web-client.js:1792`：浏览器实跑发现 390px 顶栏溢出后，修正网格最小列宽与状态簇换行，不裁切刷新按钮或导航。
- README、API 契约、设计合同和既有升级 runbook 同步；新生产文件纳入包白名单，新增测试注册到 suite-map。原消息、话题、任务、历史及人工介入路径保留。

## 关键实现

`packages/dingtalk-dsh-assistant/coordination-observer.js:40`

```js
// Compute the authoritative aggregate before bounding presentation collections.
const snapshot = coordinationSnapshot({ coordination, members, tasks, schedules, occurrences, jobs })
```

聚合使用全部真实记录；展示上限不会把未展示任务误判为已完成。GET 前后持久表对比证明读取不追加回执或改账。

`packages/dingtalk-dsh-observer/web-client.js:550`

```js
void read()
const timer = window.setInterval(read, 5000)
return () => { active = false; controller?.abort(); window.clearInterval(timer) }
```

读取范围切换时中止旧请求并清轮询，返回值还按 path 隔离旧 resource；后台失败保留同范围旧事实而不是用空态掩盖。

## 验证

- [x] `node --test --test-concurrency=4 test/coordination-observer.test.js test/http.test.js test/task-session-http-integration.test.js test/observer-client.test.js test/observer-slot-compatibility.test.js test/observer-board-restoration.test.js test/observer-node-control-display.test.js test/observer-archive-interaction.test.js test/coordination-summary.test.js test/coordination-ledger.test.js test/coordination-effective-graph.test.js` → 最终顶栏修复后 167/167 PASS，0 fail/cancelled/skipped。包含真实 SQLite/HTTP/service、GET 无持久写、分页参数、诊断过滤、完成/送达语义、慢响应与旧页面回归。
- [x] `node --check packages/dingtalk-dsh-observer/web-client.js`、`git diff --check` → PASS；`node scripts/test-suites.mjs check` → 308 files exactly once，historical 3，deleted 0。
- [x] `npm pack ./packages/dingtalk-dsh-assistant --dry-run --json` → 70 files，包含 7398-byte `coordination-observer.js`，未发布。
- [x] 独立 backend/frontend 只读审查与反证核实 → 没有保留 confirmed 缺陷；“详情返回永久禁用刷新”候选被 path identity/cleanup 生命周期反证排除。
- [x] 真实 Chrome 最终 round-3：seeded desktop light 13 cases、desktop dark/mobile light/mobile dark 各 12 cases，独立 empty desktop light/mobile dark 各 2 cases 全通过。覆盖真实生产 task service 详情→返回协调来源、生产 command→SQLite→5 秒轮询、慢响应隔离、失败恢复、焦点及 390px 无横溢出。lead 独立校验 6 JSON 的 36 次源码摘要/大小和 10 PNG 摘要/大小（合计 1,009,890 bytes），直接查看明暗手机/桌面暗色/空态截图；旧 394/390px 失败保留在 round-2。
- [x] 脚本正式输出绑定本验收根的 round-N：外部路径与非 round-N 目标均实跑 exit 2；host `--check` PASS。四个隔离端口独立回读无监听，根目录无散落审计产物。
- [ ] 完整已安装宿主、共享部署、真实模型和钉钉渠道验收未执行：本次只授权代码/PR及隔离运行，不声称已部署。

验收唯一状态表：`docs/acceptance/coordinator-work-visualization/matrix.csv`；失败与修复前证据在 `round-2.md`，重跑另记轮次。截图/SQLite 大文件不入库，scripts 提供再生成配方；修改前浏览器截图未捕获，不制造前后对照。

## 风险与边界

- 最小 ModuleLoader/slots/session 适配器加载真实 React18、原生 primitives、生产 observer 与 HTTP/SQLite，但不是完整宿主集成证明。测试输入明确标注合成，未伪造 API 响应。
- 沿用既有本机 Host/Origin 权限边界；投影不返回 actor/recipient、prompt、命令、raw proposal、路径与原始诊断。原文/判断/证据仍可能包含业务敏感文字，不是公共脱敏导出。
- 多表查询不是同一事务快照，界面说明读取窗口；轮询不会写账、重试通知或唤醒业务。详情集合超过 100 条显式截断，列表分页独立。
- 无 schema/config 迁移。实际部署需按既有 runbook 同步 Assistant 与 Observer 两包；回退为恢复原两包，不改业务账本、不重放输入。本 PR 未部署、未发送钉钉消息、未触发 CI；不合并、不推 main、不强推。
- 原生具名 teammates 已实际创建且 roster 可见，均显式 low；原 lead 保留，但工具未暴露其实时 effort，不能声明 high 已核实。辅助 Workflow 审查不冒充原生队友。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
