# 单任务固定流程与执行会话自修

## 最新目标

以用户2026-10-09最新四项指令为准：只推进SG20数据集合并交互优化，先跑通一个真实任务；SG18、SG19、SG22停止推进，SG21保留已经完成的状态。暂停保留候选、材料、原会话和审计，不使用取消任务替代暂停。

任务执行故障交原执行会话读取和纠正；监视只观察、报告和协调真实业务需求，不接管工程修复。取消模型运行时增删节点、修改节点合同、重排流程和切换流程副本的能力。历史已接纳的定义仍是恢复所需事实，不能删账或回滚已发生的操作。

## 已核事实

- SG20当前原Run为run-01a4fc72219b513a3f78e7cdb5be55699e448d6b63b97d3a65f8fcf60dc4d03f，generation6。构建节点verify-candidate已succeeded；prepare-local-acceptance因LOCAL_ACCEPTANCE_PLAN_INVALID等待。
- 原plan-local-acceptance会话f141342e-49c5-46b5-a8c5-b831cf82cb8a提交cases:[]，原输入已有criterion-1与dataset-merge-ui/UAT3场景。此为执行产物错误，不缺用户输入。
- 控制库保留generation1至6的历史节点，各代前置节点曾重新领取执行；不能将显示上的superseded理解为未执行。
- task-workflow.js的verificationTickets只存在工厂Map。重启或重建工厂丢失Map后，prepare-commit再次调用实际verifyCandidate；这会重复构建，即使候选未变化。
- 当前维护524已自然排空；SG22原apply在2026-10-09T05:09:28.084Z结束并等待方案纠正，未强制停止或补回执。后续新部署保持维护，先落盘其它任务暂停再恢复唯一SG20。

## 实施边界

1. 复用原生controller.controlTask暴露本机pause/resume，校验操作者、原Task和控制版本；暂停不改需求、不删除结果。
2. 新Owner工具移除工程repair与workflowRevision；旧尚未应用的修复决定完整封存，不再次执行，已applied不回滚。初始业务计划接纳与沿现有计划advance保留；真实用户需求变更使用需求更新。
3. 固定职责映射将prepare-local-acceptance的失败交回其真实plan输出对应的原规划会话。原会话纠正产物后，仅重组该失败准备节点输入，保留中间已完成工作区、编辑与构建，不增删节点。
4. 从同Run当前成功verify的不可变原生回执恢复检查票据，核实际候选、代次、需求、配置和摘要；候选或检查变化时才重新验证，不用放宽最终证明掩盖重复构建。
5. 原始未知或进行中外部效果先对账，不换身份重发。执行错误不得作为用户补充信息理由。
6. 批量搜索优化只处理被冻结且准入的文件，保持原UTF8、大小写、跨行、分页与哈希核验，验证后才纳入发行包；不修改业务候选。

## 验证目标

- 正式暂停SG18/SG19/SG22，SG21完成不动，只有SG20可被派发。
- 原执行会话收到实际空cases诊断并纠正，任务能完成本地验收、清理及后续真实交付。
- 同Run/generation中无关成功节点的nodeRunId、lease及outputRef保持不变；持久回执恢复后prepare-commit不再次启动相同构建。
- 新Owner修复、动态流程候选被拒绝，历史审计仍可读取。
- 包、进程、健康、实际任务和通知分别验证；测试通过不等于任务完成。不提交未完成修复。
