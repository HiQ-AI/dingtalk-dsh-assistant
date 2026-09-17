# 单消息多事项 Agent Checklist 查漏

核对基线：`C:/Users/64554/Downloads/Cortex/xt_mu560cc1542e516201/v1/out/prd-refinement/agent-checklist.md`。该文件仅作为验收清单使用，实施依据仍是仓库方案、源码和测试。

## 结论

主链路已实现并部署到本地实际 profile：一条消息可原子拆为多个 unit，分别归入 Topic、产生 Task、消费和反馈；一个事项完成后不等待同消息其他事项。正式回归 4/4、最终全量测试 429/429，实际 v7→v8 迁移、安装文件和运行态回读通过。

清单没有全部闭环。真实模型语义指标、真实 DWS 投递读回、附件页码/段落坐标和历史合并 Task 的自动拆分计划仍需后续验证或实现，因此不得据此声称自然语言拆分“零遗漏”。

## 逐组核对

| 清单范围 | 状态 | 当前证据 | 缺口或边界 |
| --- | --- | --- | --- |
| SHARED-001、F1-1～F1-25 | PASS（结构与 Host 行为） | `decision.js` 的 units/ignoredRefs/sourceRefs/contextRefs/effectOwner；`store.js` 的唯一锚点解析、覆盖校验、原子路由；#1066 正式回归 | 自然语言拆分准确率另见 F8，结构完整不代表语义正确 |
| SHARED-002、005～009、F2-1～F2-15 | PASS | UTF-16 半开区间、稳定 unitId/revision、显式 replacesUnitIds、固定 Topic revision、回执保留测试；实际 profile v7→v8 迁移验证通过 | — |
| SHARED-010～011、F3-1～F3-14 | PASS | basisUnitRefs 逐动作校验；Task 仅存 topicRefs；叶子只读取事项范围；同 messageId 的兄弟事项不进入回复候选；附件阻塞按 unit 隔离 | 附件影响范围不明时仍依赖路由模型给出正确引用 |
| SHARED-012～014、F4-1～F4-17 | PASS（本地协议） | 完成通知按事项冻结边界；兄弟 Topic pending 不阻塞；Outbox 携带 matterUnitRefs；旧 Task 轮次通知标为 superseded；发送层继续使用 `Promise.allSettled` | 真实 DWS 发送、撤回与群回读未执行；进程重启后通知冻结序号未单独做强杀恢复证明 |
| F5-1～F5-2 及共享展示项 | PARTIAL | HTTP 保留原消息并投影各 active unit/Topic，返回 pendingUnitCount/pendingUnits；消息聚合状态不参与结果回复准入 | Observer 前端没有新增专门的范围高亮、共享限制和三阶段状态组件，只能使用现有详情与新增 API 数据 |
| SHARED-003、F6-7 | PASS | 普通路由、复核、Web Host unit、内部/只读路径、历史迁移统一携带 unit/version 来源 | — |
| SHARED-004、F6-3、F6-8 | PARTIAL | `group_topic_route_context_get` 按冻结原文坐标顺序分页；未读完拒绝提交；最终一次原子接受完整路由 | 未实现“暂存多段 unit 输出”的独立协议；当前仅分页读取、一次提交，超大最终 JSON 仍受工具预算约束 |
| SHARED-015 | PASS（文本锚点） | quote 必须在固定版本原文中唯一命中；缺失或重复即拒绝；覆盖中文、Markdown、无换行输入的测试 | 表格、emoji、重复句的组合用例未形成独立 gold 统计 |
| F6-6 | NOT IMPLEMENTED | 附件以真实 attachment ID 关联 | 尚未保存附件页码、段落坐标和权限范围 |
| F7-1 | NOT IMPLEMENTED | unit 拆分/合并可记录前后映射和效果继承 | 已存在“合并 Task”的读取成果、受控停止旧任务、创建独立任务与可恢复进度计划尚未实现 |
| F8-1 | PASS | profile 依赖回读指向本轮唯一 tgz，关键安装源码摘要与工作区一致，domain version 8，双端口及 health 回读通过 | — |
| F8-2～F8-10 | PASS（本地与实际 profile） | 诊断脚本已改为正式目标断言；#1066 拆为 3 个目标，四项回归保持一个目标；迁移、并发、重启、部分失败由测试覆盖；实际 v8 Runtime 和任务表回读通过 | 真实群投递未执行 |
| F8-12 | PASS（样本冻结） | `fixtures/message-multi-topic-gold.json` 覆盖应拆、应合、背景、混合授权、纠正和对抗改写 | 尚未用生产配置模型跑样本 |
| F8-13～F8-15 | NOT VERIFIED | 已区分 Host 结构测试和语义评测；已完成部署增量与运行态回读 | 未取得过度拆分率、漏拆率、错误续接率、授权扩大率及历史 Task 成果分配 |
| F8-16 | PASS | 文档和交付结论均保留语义边界 | — |

## 发布前必须补证

1. 使用生产配置模型运行冻结 gold，分别统计过度拆分、漏拆、错误续接和授权扩大。
2. 在获准的真实群验证三个事项独立确认、独立完成通知、单条失败隔离及群消息读回。
3. 若本期要求完整满足 F6-6、F7-1 或超大路由分段提交，需继续实现后再发布。
