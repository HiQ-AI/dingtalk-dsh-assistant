# 任务卡片归档与全看板单展开验收

基线：远端 main `3c028dd`，包含 PR182/183/184/185。本次按授权提交为 Draft PR，不合并或部署；没有归档任何现场任务。未修改 dsh-bytebase-mcp。

## 原机制结论

归档不是 PR183/184 单纯漏掉一个按钮。PR171 (`85d7039`) 清退旧工作流 UI 时移除了原卡片归档入口，并将 `/tasks/:id/archive` 纳入 HTTP 410 退役规则。旧实现仍留在 runtime.js / workflow-service.js / execution-store-worker.js：使用 archivedAt 或 task.archive 事件保留历史，要求完成（包括取消）且执行排空。当前动态任务的 JSON SQLite 账本原先没有归档命令或字段写入。

本次复用 URL、archivedAt 投影、现有看板排除过滤与“历史任务”列表，为当前动态任务增加事务性的 task.archive 命令，在原 dynamic_tasks JSON 和 dynamic_receipts 保存 archivedAt/archivedBy 与命令收据，无需 SQL schema 迁移。不删除任务、执行、结果、材料、通知或目录，不调用取消/停止执行。旧目录清理归档机制与旧工作流不复活；旧任务写入仍被拒绝。没有恢复入口，历史仍可读取。

运行中、等待中、会话尚未排空或存在未结束执行/效果的任务不能归档（409）。已取消任务只有排空后才可归档。界面给出中文原因，不将归档当作停止操作。

## 修改清单

- observer web-client：右下角归档图标、中文按钮/提示/可访问名称；阻止冒泡；同步防重复及禁用；仅收到匹配 taskId 和 archivedAt 才更新对应任务；失败保留卡片并告知；阻止归档前已发出的过期列表读取复活卡片。
- 单一 expandedTaskId：首次成功异步加载仅展开执行中 updatedAt 降序第一项；无执行中全部收起；跨桶单展开、允许全收起；自动刷新不覆盖选择；归档/移除展开项后清空，不重新默认。
- dynamic-task-store / task-session-service / resident / http：原账本归档命令、可信 Web actor、当前服务接线、本机身份及严格空 body 检查；旧任务保护。
- DESIGN.md / UX-CONTRACT.md：更新上述交互与生命周期约束，保留主题 token、响应式列数、执行名称/状态/数量、原卡片布局。
- 相关单元/HTTP/SQLite 与浏览器 fixture 验收。

## 验证结果

310 项定向测试：308 通过、0 失败、2 跳过。包含 premium-ui.json 的全部 unit 命令及新增归档/单展开、旧卡片、动态账本、真实服务 HTTP 集成测试，以及话题决策、新消息归档保护和调度恢复测试。命令及逐项输出见 evidence/targeted-tests.log。跳过的是 task-session-names-native.test.js 的两项原生链路测试：环境缺少 @deepseek-ai/dsh-base 完整 profile；动态命名持久化与卡片回归已通过。

浏览器实跑 Chromium + React 18；完整 observer 源码，宿主 UI primitive/slot 使用语义替身。归档通过真实 handleRequest → task-session-service → 独立临时 SQLite，不通过模拟归档响应。模型、DSH 会话执行及钉钉传输均不连接；所有非 fixture 源与非 127.0.0.1:18998 预期 API 请求拦截，18998 请求转送到随机端口临时 HTTP 服务，绝不访问该端口的真实 resident。脚本结束删除临时 DB。

浏览器覆盖：首次异步读取及执行中显示排序、无执行中默认收起、跨桶单展开和键盘 Enter、手动全部收起后刷新、归档当前展开项后清理并保持全收起；运行中拒绝且 control 保持 active；失败保留卡片/DB、重复点击只发送一次、点击隔离；成功后历史列表；SQLite 服务重启及浏览器重载后 archivedAt/结果/执行历史保留；390px 窄屏及原 11px 13px padding / 6px gap。详见 preview/results.json，浏览器 pageerror 为 0。

截图：preview/initial-single-expanded.png（首次默认）、desktop.png（手动全收起）、failure.png、history-after-restart.png、narrow.png。均为实际浏览器截图，宿主按钮外观由 fixture 语义替身提供，不代表现场 DSH 原生外壳或部署验收。

`git diff --check` 与变更 JS 的 `node --check` 通过。项目未配置单独 formatter/typecheck/build 命令，未运行全量测试。frontend-design / frontend-design-premium 主指引已读取；会话中技能随后被平台撤回（skill package is not available），无法取得附属 verification-checklist 或 audit_project.py，未声称该技能静态审计已运行。

复跑浏览器：先在隔离目录安装 react-dom@18.3.1（本次 /tmp/archive-browser），脚本可用 DSH_BROWSER_DEPS / PLAYWRIGHT_MODULE / CHROMIUM_PATH 调整依赖与浏览器位置；默认使用环境自带 /opt/codex/cua_node/lib/node_modules/playwright 与 /usr/bin/chromium。执行 `node docs/acceptance/task-card-archive/scripts/verify-browser.mjs`。

## 归档后防自动复活补充

本次明确的产品行为变更：旧设计允许已归档任务通过相关新消息重新打开；用户选择保留本次“归档后不再自动重新驱动”的行为，该变更不应称为旧设计缺陷。实现如下：动态账本拒绝归档任务的 reopen/revise/control 与 task.claim/wake.claim，executionCurrent 不接纳归档所属执行；服务在任务/执行实际准入、排队调度、provider retry、后台恢复与进度恢复边界跳过归档任务；话题协调的可操作列表过滤归档项，陈旧显式动作在 decision 校验及 applyTopicAction 再次拒绝。显式历史读取仍开放；未添加新恢复界面或全局工具门禁。新事项沿现有 new-task 创建/关联任务。

新增测试证明：归档后同话题新消息不能 reopen，正规 new-task 仍可执行；归档先提交时并发 wake.claim 被拒绝，reopen 先提交时归档被拒绝，不形成 active + archivedAt；任务控制/revise/reopen 均拒绝归档目标；后台恢复及服务重启未运行归档任务，未归档正常接续仍运行。浏览器复跑通过，额外覆盖真实账本 reopen 被拒绝、归档状态不变，pageerror=0。

Library 截图交付：用户要求的 initial-single-expanded.png 与 history-after-restart.png 已尝试正常批量保存，本次按要求重试一次仍在连接阶段 network 失败，未创建 Library 文件，没有 library_file_id；保留所有本地截图，不绕过权限。
