# 开发任务 UAT 交付闭环

> 已被可配置任务流程/证据引导取代。本文保留为当前 Agent 可填写的开发类业务流程参考，不再是插件内置校验契约。

## 目标

开发类群聊任务不能在“代码已修改或本地测试通过”时结束。叶子会话必须继续把开发分支合入任务对应的 UAT 分支，确认 Woodpecker 自动构建成功，并确认目标 Pod 已完成滚动更新且健康；完成证据通过结构化结果交给 resident 主会话，由主会话通知原群中的任务负责人。非开发任务不强制进入部署链。

## 设计边界

- 继续使用 DSH 原生叶子 Session、Goal、工具与工作区权限，不新增执行器。
- Git 合并、Woodpecker 查询、Kubernetes 验证均由叶子按当前项目代码、`AGENTS.md` 和既有 runbook 执行；插件不复制 Git、CI 或 Kubernetes 客户端。
- Runtime 只维护 Task 生命周期、通用“至少一条可核验证据”门禁、巡检恢复、主会话协调和可靠 outbox；具体平台字段由 Agent 配置注入叶子，不由插件强校验。
- 生产发布、敏感操作等既有审批红线不因 UAT 自动交付而放宽。

## 结果契约

`submit_task_result` 增加 `workType`：

- `non-development`：保持现有完成证据要求。
- `development`：`status=completed` 时必须同时提交 `delivery`：
  - `sourceBranch`：实际开发分支。
  - `targetBranch`：实际 UAT 分支。
  - `mergeCommit`：UAT 分支可回读的合并提交。
  - `woodpeckerBuild`：构建 URL/编号及成功状态。
  - `pods`：目标 namespace/workload、滚动更新结果和健康 Pod 证据。

这些字段可作为本机开发类任务的配置模板；Host 不再识别 Woodpecker、Kubernetes 或 UAT 语义。叶子必须按配置要求取得证据，不得把尚未达到所选流程完成条件的事项包装成 `completed`。

## 无结构化结果的恢复

Goal/turn 已完成但未调用 `submit_task_result` 时，不立即新建叶子：

1. 首次发现时恢复同一 Goal，并向同一 Session 追加一条结果闭环提示，要求继续完成缺失交付步骤并调用工具。
2. 只有同一 Session 再次无结构化结果结束，才按现有上限重建叶子。
3. 达到恢复上限后才进入真人处理；Supervisor 必须保留活动告警，不能显示为正常。

这避免已经完成代码与部署工作的叶子因只输出自然语言总结而被丢弃。

## 通知顺序

1. Host 校验结构化结果和开发交付证据。
2. Task 原子转为 `completed`。
3. Runtime 把完整证据发送给 resident 主会话。
4. 主会话生成面向原任务负责人的简洁通知，包含 UAT 分支、构建、Pod 和验证结论。
5. 通过可靠 outbox 投递原群；投递状态可在消息列表查看。

Task 完成与群消息投递分别记录，通知失败不能回滚已验证的业务完成，但必须形成可重试告警。

## 验收

- 开发任务只提交代码与测试证据时，完成结果被拒绝。
- 提交完整 UAT/Woodpecker/Pod 证据时，Task 转为 `completed`。
- 完成后 resident 主会话收到协调信封，outbox 产生一次幂等通知。
- 叶子自然结束但未调用工具时，首先恢复原 Session，而不是立即丢弃并重建。
- 当前两条已有任务能基于叶子现有成果继续交付或补交结果，不再保持假 `running`/错误 `waiting`。
