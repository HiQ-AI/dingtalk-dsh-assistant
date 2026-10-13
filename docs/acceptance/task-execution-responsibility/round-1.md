# 第一轮：接线与反证

日期：2026-10-13。隔离 worktree，Node.js + pnpm workspace；未触碰运行实例或真实消息。

## 实跑与观察

- `pnpm install --frozen-lockfile` 成功，250 个依赖全部来自缓存，workspace 链接指向本 worktree。
- `node --test test/workflow-recovery.test.js test/task-owner-recovery.test.js`：当时尚未加入新 Service 用例，24/24 PASS，见 round-1-baseline.log。
- 子代理新增真实 SQLite/Controller/Service 测试时，3 个正向用例失败：输出 schema 错误让 Run 为 failed，原扫描 activeOnly/terminal 同时排除，calls=1 而非2。修复为显式纳入当前活动任务的失败 Run，仍由 inspectNodeRecovery 与 node.resume 重验。
- 独立审查发现仅提供工件引用不能保证无工程读取工具的通用节点可读。恢复上下文新增完整白名单 evidence 正文，后续轮次增加正文断言。
- 修复后 `node --test test/workflow-recovery.test.js`：13/13 PASS，见 round-1-service.log。覆盖 failed 原身份续行、重启、同问题不空转、无提交 waiting、pause/cancel/需求/来源/unknown effect/code failure、扫描公平性。
- 责任提示及分类定向9/9 PASS；完整三文件运行暴露2处旧测试要求 Owner 手动 resume，已调整为 Controller 受管续行，保留底层直接重领拒绝与无进展保护，定向2/2 PASS。完整回归结果记入第二轮，不能把首轮输出视为最终全绿。

## 边界

本轮只证明隔离控制链路和确定性会话替身行为；原生会话回归、最终组合回归和审查尚未全部结束。未部署、未运行真实模型业务任务、未验证钉钉送达。
