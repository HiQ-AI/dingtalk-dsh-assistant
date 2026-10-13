# 任务会话与流程步骤关联修复

日期：2026-10-13。基线：origin/main 1cd06d2（PR #159 已合并）。本文件是修复前方案快照；进展继续维护原 task-detail-redesign/goal.md。

## 目标与现状

修复审查确认的四项缺陷：任务会话直接完成时没有入口且显示步骤待确定；未绑定节点会话出现跳转按钮；检查配置修订改变 workflowId 后保留步骤被误判为删除；切到其他页面后的刷新丢失选中步骤。仅修改任务详情投影与展示，不改变执行、审批、恢复或完成门禁。

源码依据：workflow-service.js 的 currentPlanNodes 使用 workflowId 组成 stepKey，tasks 未过滤节点预分配 sessionId，零阶段固定 stepsResolved=false；web-client.js 只显示节点会话且刷新从 DOM 读取选择。已用隔离 Service、真实 v25 registry.updateCheckpoint 与浏览器复现，证据在 docs/tmp/task-detail-review/。

## 关系与修复方案

任务有持续执行会话，可以直接查询并完成，也可以编排多个流程。流程实例包含步骤，Agent 步骤另有节点会话；代码步骤不虚构会话。

- 任务详情复用宿主 Button，在目标与结果之间显示任务执行会话及“查看任务会话”入口。只对 sessionBound=true 且有 sessionId 的会话提供导航；尚未建立的会话显示真实空态。节点入口同样检查绑定，并明确为“查看步骤会话”，避免把节点会话与任务会话混称。
- 服务端 taskOwner 增加 sessionBound，未绑定身份返回 sessionId=null；节点投影同样过滤。任务已结束且零阶段时 stepsResolved=true，前端显示“本任务未使用工作流”；未完成且零阶段仍是待确定，未知流程定义仍显示步骤待确定。既有 node/产出/权限合同保持。
- 阅读身份使用任务、stageId、流程实例 runId、逻辑 nodeId。未启动阶段复用 controller.plannedTaskStageRunId 的既有确定性身份，启动前后保持；节点重试和维护 checkpoint 保留 runId，故有效步骤保持；真正替换流程实例或重用 stageId 时获得新身份。用 JSON.stringify 数组避免分隔符碰撞，无 schema 迁移，不新增另一套身份算法。
- 前端保存当前任务的阅读选择与当前步骤目录，以 React 状态及最新引用供异步回调读取，不以页面是否挂载推断步骤删除。切页后台刷新保持选择；真实删除按原顺序选择相邻项，回到任务页后再恢复焦点，不能抢其他页面焦点。产物继续由 runId/nodeRunId/outputRef 与 detailRevision 校验。

## 取舍与反例

不采用 workflowId（检查配置修订会变）或 nodeRunId（节点重试会变）作为阅读身份。不仅用 stageId/nodeId，避免被替换的同名流程实例复用旧身份。不新增全局事件时间线或流程折叠，本轮只闭环已确认关联问题。

保留先前正常路径：跨流程同名步骤互不合并；普通重试读取新产出和新会话；真正删除步骤提示并定位相邻；慢响应及失败刷新不能覆盖或清除已读内容；成功/失败/未知会话绑定不相互混淆。任务会话入口提供整体执行记录，接管步骤保留其原自动节点会话，不改写历史来源。

## 实施与验收

后端实现及 checkpoint 回归、Service 场景回归、前端实现、浏览器验证分别分工，禁止交叉覆盖源码。复用既有验收脚本、matrix.csv，新增 round-4；失败修复后递增轮次，不覆盖旧证据。回归覆盖零流程完成/未完成、任务与节点会话绑定、跨流程/重试/检查修订身份、切页刷新和隐藏时真实删除、窄屏键盘。定向测试、UI严格审计、两包打包及包内源码回读完成后提交新分支PR。正式部署不在本轮范围。
