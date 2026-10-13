# 任务详情改版

- 状态：已完成
- Goal ID：task-detail-redesign
- 最近维护：2026-10-13T11:23:22+08:00
- 权威目标：goal.md

## 总目标

将任务详情改为可定位、可持续阅读的步骤工作台，准确表达任务执行会话、流程实例、步骤及其当前有效结果。

## 完成条件

页面改版及后续审查发现均有回归证据；同名跨流程不串用，重试和检查修订保留正确身份，真实会话可进入，零流程任务与待定计划区分；新分支PR独立回读。

## 范围与约束

复用现有服务投影、宿主组件和 docs/manual/observer-design.md，不改变执行授权或完成门禁。保持主检出已有改动，正式部署未授权；所有证据进入 docs 子桶。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | 详情版式与阅读体验 | 当前完整步骤目录与阅读面板通过验收 | PASS | round-3.md，16/16浏览器场景，35/35定向测试 |
| SG2 | 首轮PR交付 | 分支及PR独立回读 | PASS | PR #159；本轮gh回读已MERGED，origin/main 1cd06d2 |
| SG3 | 会话与步骤身份修复 | 四项审查缺陷及关联边界回归通过 | PASS | 后端10/10、Observer38/38、真实checkpoint1/1；round-4至round-6 |
| SG4 | 修复浏览器与工程验证 | 新轮matrix全绿，真实交互/定向测试/双包回读 | PASS | round-9浏览器24/24、matrix31项、双包逐字节回读；历史失败保留 |
| SG5 | 修复PR交付 | 新分支提交推送、PR正文与head独立回读 | PASS | PR #162 OPEN/MERGEABLE；正文与产品提交92a3a0b独立回读一致 |

## 当前检查点

- 当前子目标：SG5
- 唯一下一步：无；本轮源码修复与PR交付完成。
- 未闭环项：无；正式实例部署不在本轮范围。

## 进展

- 首轮以 origin/main 462c213 为基线完成目录/阅读面板；第2轮发现窄屏默认选中项不可见，第3轮修复，历史FAIL保留。
- PR #159 已合并（2026-10-13 gh独立回读），不再往旧分支推送。本轮复用原独立工作树，从最新 origin/main 1cd06d2 建 worktree-task-detail-associations。
- 用户要求审查后修复。审查已复现任务会话漏展示、未绑定会话导航、checkpoint改变步骤key、跨视图刷新丢选择；36项既有定向测试通过，说明需补组合回归。
- 修复分工已完成。round-4/5保留测试准备错误和纯会话截图夹具错误，round-6业务回归通过；独立复审新增跨任务旧提示残留，修复后异步unit已38/38通过，浏览器已在round-9通过24/24；round-7保留视口测量同步失败，round-8保留子夹具阶段不一致，最终均闭环。

## 重大决策

- 本轮范围扩展至后端只读投影，但不改schema或执行生命周期。
- 稳定步骤身份复用现有确定性阶段runId；workflowId是可变定义身份，nodeRunId是重试引用，均不单独充当阅读身份。
- 任务会话与步骤会话分开命名，绑定成功才可导航；零流程已结束任务不再标成待定。
- 使用状态保存阅读选择，DOM仅承担焦点与滚动操作。

## 重要信息

- 工作树：D:/project/dsh-task-detail-redesign-20261013；分支：worktree-task-detail-associations；base：1cd06d2。
- 首轮交付：https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/159（已MERGED）。
- 本轮交付：https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/162（独立回读OPEN、MERGEABLE，main ← worktree-task-detail-associations；正文与产品提交92a3a0b一致）。正式实例未部署。
- 分工：后端投影及checkpoint、Service场景测试、浏览器脚本由三个子代理分别负责；主代理负责前端、文档、整体验证与PR。
