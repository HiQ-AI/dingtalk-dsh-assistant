# Resident、Topic 与叶子 Task 协作改造计划

## 目标

在保留“每群一个 Resident、持久 Topic、每 Task 一个叶子 Session + Goal”主体结构的前提下，修复审计 F1–F9 的确定性问题，并降低 Resident 的重复审阅和上下文负担。

## 改动

- Host 对 `new-task` 增加职责和明确授权校验；Resident 使用 `read-only`，叶子使用 `workspace-write`。
- 审批指纹绑定 Task、执行轮次、动作和风险；waiting 释放执行名额，恢复时重新参与 FIFO 调度。
- Task 补充合并 Topic 引用，并以 `progressImpact` 区分保留进度与重规划。
- checkpoint 重试复用原记录，Supervisor 恢复未完成审阅；普通阶段由 Host 直接确认。
- 取消和 Topic decision 接受不再等待无关 Task 生命周期队列。
- 附件硬阻塞只核对本次决策依据；Observer 按 Topic 工作流投影消息状态。
- Task、Topic、消息动态信封增加字符总量边界和分页入口；删除两个无调用包装函数。

## 验证

- `node --test docs/acceptance/resident-topic-leaf-audit/scripts/probe.mjs`
- `pnpm test`
- 三个发行包执行 `pnpm pack`。
- `git diff --check` 与 long-goal 校验。

真实 DWS 群消息、网络工具权限隔离和本机 profile 部署不在本轮执行范围，不能用隔离测试替代。
