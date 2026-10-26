# PR260 独立审查与受控部署门禁

## 结论

独立审查确认并修复一项 P2 计时错误：独立协调同一 generation 自动重试时，queue 使用零基 ledger.attemptCount，turn/host 却使用 generation，不能正确关联同一次尝试。修后相关三文件 46/46、最终三包 release smoke 14/14，均无 fail/cancel/skip；真实 Edge 隔离浏览器五项通过。未重复无关全量或 32 代基线。

部署门禁当前未通过：只读原生检查实际退出 1，错误为 `DEPLOY_NOT_DRAINED`，不能切包。原生日志证明存在真实未结束回合，不是凭过期 drained 字段猜测，也不是检查器故障已修复。尚未取得原生双包部署 Check 的成功结果，未停止运行实例、未安装包、未重放或外发。

## 最小修复及反例

- `packages/dingtalk-dsh-assistant/independent-coordination-service.js:560` 保留 queue 的账本次数，并在 planner.plan 输入显式传入同值 attempt。
- `packages/dingtalk-dsh-assistant/independent-coordination-planner.js:152`、`:168` 的 host/turn 使用 request.attempt；generation 继续用于原有 ownership/fence，不改变来源准入、提案或版本判定。
- `test/independent-coordination-native.test.js:89` 在已有真实首次未提交、5000ms 后重试澄清成功的场景，补首轮全部 attempt=0，下一轮独立 span 的 queue/turn/host 全部 attempt=1。
- 修前运行 `node --test --test-name-pattern='successful clarification after retry' test/independent-coordination-native.test.js`：1 fail，实际 `[0,1]` 对预期 `[0]`。最小修复后同命令 1 pass / 0 fail / 0 skip。
- README 和部署说明同步；本特性部署文档明确转到 task-session 原生双包流程，不把旧 workflow maintenance 不可用当作 Bootstrap 许可。

## 原团队本轮独立复核

原 latency-data 与 latency-source 均复核本轮 attempt 修复，不以旧 finished 状态充当结论。已独立回读原成员会话的最终文本与时间：

- latency-data，2026-10-26T05:56:28.602Z：确认 queue 与 planner 同值、turn/host 贯通，搜索无其他生产 planner.plan 漏传入口；generation 仍用于 ownership，多 turn 仍以独立 span 区分；未发现进一步遗漏或反例。未扩测、未编辑、未部署。
- latency-source，2026-10-26T06:07:26.388Z：确认本轮未改变 generation/fence、来源版本及 DTO 白名单；新增 native 断言覆盖首轮 0、重试 1 和 span 独立；未发现状态、版本或隐私行为回归。未扩测、未编辑、未部署。
- 额外只读 reviewer 首先以最小 planner probe 复现该错误；原团队也独立核实源码路径。reviewer 原相关四文件 95/95 与本轮 46/46 范围重叠，不相加，不当作修后重跑。

## 修后验证

| 用例 | 结果 | 本机证据 |
| --- | --- | --- |
| 同代重试新增断言 | 修前 FAIL，修后 1/1 PASS | 本节复现命令与实际断言 |
| independent-coordination-native + coordination-sessions + task-message-projections | 46/46，0 fail/cancel/skip，71405.1933ms | round-9/targeted.log |
| 最终 tgz release smoke，含真实解包任务与 resident health | 14/14，0 fail/cancel/skip，32237.5452ms | round-9/release-smoke.log |
| 真 Edge + 实际 HTTP + 完整 Observer 隔离夹具 | 五项 PASS，errors=[]，writes=[]；Edge 156.0.4314.42 | round-9/ui-script-final/browser-result.json |
| client build / test mapping | 308 文件各映射一次，非全量测试 | node scripts/build-web-client.mjs；node scripts/test-suites.mjs check |
| Assistant / Observer 包逐文件对源码 | 69 / 4 文件一致 | 原生 inspect-quiescent-ledger.mjs package 输出；round-9/validation-summary.json |

`verify-inbox-browser.mjs` 新增显式 `--installed-profile`，只读加载该 profile 的 Assistant HTTP 与 Observer bundle；不改 profile，也不连接真实业务写接口。默认 worktree 路径已经真实 Edge 再跑五项通过。安装后必须另跑 installed 模式，不能以默认模式冒称已安装验收。截图已目视核对状态、独立事实、负时及展开详情；PNG 和原始日志不提交。

## 部署失败原因及现场只读反证

- `node docs/acceptance/task-session-runtime-repair/scripts/inspect-quiescent-ledger.mjs D:/baibu-agent/.dsh/task-sessions.sqlite D:/baibu-agent` 实际退出 1：`DEPLOY_NOT_DRAINED`。失败原文来自已结束命令输出，不以工具成功回执代替。
- 首次轻量账本复核：1 个 undrained execution、7 个 starting operations。后续 2026-10-26T06:07:13.811Z 只读诊断为 2 个 undrained（统筹和执行）、8 个 starting operations、0 个 starting notifications，说明现场仍在推进，不能强停。
- 统筹原生日志：41 个 turn/start、40 个 turn/end，最后 start sequence=1399，最后 end sequence=1395；执行原生日志：8 start、7 end，最后 start sequence=2267，最后 end sequence=2263。二者均有真实未结束回合，不满足静止切换条件。
- 脱敏数量及序号见 `round-9/deploy-activity-initial.json`；无正文、原始任务/执行/群消息身份。此文件是只读诊断，不是原子排空或停机许可。
- 当前 `/runtime/maintenance` 返回 `workflow_maintenance_unavailable`，不是 404。`docs/ops/task-session-clean-start.md:62` 明确本运行时无旧 workflow maintenance，使用 `deploy-task-session-native.ps1`；不能改用 Bootstrap 或旧 workflow 脚本绕过。
- 现场双端口 3080、18998 均为 127.0.0.1、同 PID 93604；计划任务 DSH Web Local 启用；健康读取不能替代 drain。profile SHA256 为 `74fe100c0019f5e4c76c06903fdb622b0af5696afc60ab38cbd252ce8f948499`，尚未修改。

## 待完成及边界

审查确认后方可更新/合并 PR；合并结果须独立回读。部署必须在自然静止后以精确双包、PID、profile 摘要先 Check，再经原生 SIGINT disposal、旧 PID 退出、owner/日志/子进程排空才安装。未通过不得强停、取消任务、改账或把失败改 PASS。新包源码冻结，不引入配置/schema 迁移，不备份历史副本。

安装后另核双包哈希/版本/新 PID/健康、installed fixture 与现场已有条目只读投影；真实钉钉新消息及业务验收不在本轮自动外发许可内。原分析 report/CSV 冻结；唯一 goal/shared/matrix 仍在原任务根，本轮工程文档不是第二份权威进度。
