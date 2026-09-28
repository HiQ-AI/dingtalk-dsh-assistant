# 实施与验证计划

原生 store 从 task.web-rerun.accept 事件构建 task.family / task.catalog 查询，覆盖完整关联树及全部任务而非仅最近 200 个运行。归档在同一事务内检查整个 family 并记录全部成员，重复提交保持幂等；重执行检查最新成员、全体终态、租约与效果，阻止从旧入口创建并发执行。

workflow service 保留单次详情接口，增加 boardTasks 和 taskExecutions：卡片取最新可读执行的原字段，额外元数据仅供详情；历史先校验可读范围再分页。resident 将 listTaskView 接到汇总入口，HTTP 增加 executions 查询。

Observer 保留原卡片渲染及详情步骤区，在详情之外增加选择执行和历史分页；按内部执行 ID 读取对应详情和产物，历史只读且异步请求隔离，保留旧链接与失败重试。旧版任务继续原有同 taskId 轮次模型，既有历史呈现需核对其数据边界。

验证：原生缺失祖先/关联树/并发/原子归档/重启；service 权限反例、超过 200 条、分页、卡片字段；HTTP 参数及错误；observer 请求与交互，卡片/步骤原渲染保持一致；两项真实数据在隔离副本或只读投影中 13→2，历次状态不串次。相关定向回归与 Web bundle 构建后打包，PR 前回读 diff 和 PR state。
