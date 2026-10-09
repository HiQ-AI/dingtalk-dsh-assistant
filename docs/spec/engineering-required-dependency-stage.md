# 同 Task 必要工程依赖

SG22 当前前端 Run 已保留成功候选，但本地验收缺少需求中“失败明细下载”的真实后端。现计划只能追加到末尾或废弃后缀，前者形成等待环，后者丢失原工程进度。

最小路径是在原等待工程阶段之前插入一个必要工程阶段，不引入 DAG。Owner 使用 insertDependency，来源仍绑定当前人类需求原文；sourceCondition.repositoryId 指定已由 Host 配置允许的必要仓库。Host 的 dependencyRepositories 仅限制路径，不能代替原需求授权。依赖必须服务原目标、继承同 UAT、同 requirement/source 版本，不能改变外部发布批准。

仅当原 Run waiting、所有节点及效果排空、无待处理输入时插入。事务保留原 stageId、Run、generation、输入、节点及效果历史，临时将原阶段 blocked；必要阶段完成后原阶段恢复 running。不重建原 Run，不重跑成功节点。原 Run 的正常派发仍由现有阶段 running 门禁控制。

新增字段复用持久 sourceCondition；新增计划动作复用 Owner 接纳、来源校验、控制版本和事务收据。新后端阶段独立工程工作区是必要的新业务工作，前端工作区不动。测试覆盖来源/仓库越界、活跃节点、待处理输入和未知效果拒绝，以及依赖完成恢复原 Run。

## 未应用的依赖决定恢复

现场 SG22 的 insertDependency 已被 Owner 接纳，但在仓库范围检查时失败，尚无 owner-plan 收据。application_status=blocked 不在自动应用队列；新事件与原模型失败 retry 都不能解除该屏障。

复用 task.owner.retry，只允许 ENGINEERING_REPOSITORY_SCOPE_MISMATCH 对应的当前 accepted/blocked advance.insertDependency：Owner 全版本、当前 Task/计划/来源一致，原工程阶段 waiting 且排空，无待处理输入或未决效果，当前决定没有 owner-plan 收据。事务将旧决定 application 标记 discarded，保存原决定和失败，记录恢复事件及旧 turnId，再唤醒原 Owner 重评。已有成功 workspace/edit 不要求清零，不修改原 Run/节点/效果；新决定仍走正常权限和范围校验。其他动作、错误、过期来源、应用过的决定不能使用此路径。
