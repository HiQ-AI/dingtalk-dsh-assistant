# 第 27 轮：原有任务流程目录迁移

日期：2026-09-24。此轮针对用户提出的“原有多个任务流程是否全部按新编排重做”进行反向核查和补缺。以下状态以源码路径与本轮实跑为准，不以旧配置有提示词或模型报告为准。

## 迁移基线

现场 v9 配置有 10 条启用的 `taskPrompts`：排查、方案、PR 评审、开发、UAT 交付、生产发布、数据查询导出、数据变更、复盘、UAT 同提交重构建。原新入口仅接受 `task-analysis` / `task-engineering`；旧任务继续由 `runtime.js` 的叶子自行选择提示词。新群不允许回落旧引擎，因而原 10 类**尚未全部迁移**。

| 旧流程 | 本轮固定编排 | 实际准入状态 | 当前证据边界 |
| --- | --- | --- | --- |
| 排查 | `task-investigation` | 已接消息入口 | 仅已提供材料 |
| 方案 | `task-planning` | 已接消息入口 | 仅已提供材料；不自动实施 |
| PR 评审 | `task-pr-review` | 已接消息入口 | 无远端 PR 读取，不能声称实时审查 |
| 开发 | `task-engineering` | 原已准入 | 仅登记仓库、受管候选与首次 PR；旧分支续作需补 |
| UAT 交付 | `task-uat-delivery` | 待真实 Host adapter | 合成固定节点和效果合同已实跑；无平台执行准入 |
| 生产发布 | `task-production-release` | 待真实 Host adapter | 合成固定节点；正式批准与生产发布尚未实跑 |
| 数据查询导出 | `task-data-query` | 已接材料审查入口 | 无数据库查询与文件导出 |
| 数据变更 | `task-data-change`（含准备节点） | 待真实隔离演练/Bytebase adapter | 合成工单、审批及 Task 回读已实跑；生产未执行 |
| 复盘 | `task-retrospective` | 已接消息入口 | 仅已提供任务记录 |
| UAT 同提交重构建 | `task-uat-rebuild` | 待真实 Host adapter | 合成固定节点和版本保护合同；无流水线执行准入 |

## 本轮已实跑的证明

- `node --test test/workflow-approval.test.js test/workflow-service.test.js test/message-workflow.test.js`：39/39 PASS。证明消息入口、五类材料流程、四类受信适配器条件准入、同请求 Web/IM 首终态审批和消息容量边界。
- `node --test test/workflow-recovery.test.js test/workflow-service.test.js`：22/22 PASS。验证注入 Controller 的恢复路径与入口。
- `npm test` 首轮 850/851，唯一失败为注入的旧 Controller 假对象缺少 `registerWorkflow`；修复后全仓重跑 851/851 PASS，日志为本机 `docs/tmp/task-flow-full-test.log`（不入库）。

## 尚未关闭

现有 Host 没有实际 Bytebase、Woodpecker、UAT/生产发布适配器；不可仅给三个发布流程接注册表或让模型自由调用工具就宣称迁移完成。数据变更的隔离演练目前由受信适配器直接调用，必须在接入真实适配器前纳入效果账或证明为纯只读模拟，不能把合成测试视为生产安全证明。审批请求的 IM 通知及真实 Web 路由还需端到端验证。生产 SQL、工单审批、发布、真实数据库查询/导出均需独立接入和验证。历史 Task 不迁移、不重放；本地正在运行的插件仍是上一轮安装版本，本轮源码未部署。
