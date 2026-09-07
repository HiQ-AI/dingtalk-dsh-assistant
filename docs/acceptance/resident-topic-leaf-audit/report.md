# Resident、Topic 与叶子 Task 协作改造验收报告

## 结论

F1–F9 的确定性问题已按当前 DSH 能力完成收敛，A01–A10 修复探针全绿，新增无损 JSON 回归后的 237 项测试无回归，三个发行包可生成。

## 已实现

- 新任务准入由模型规则和 Host 来源校验共同约束。
- Resident 与叶子分别采用只读和工作区写入文件权限；网络工具边界已明确记录。
- waiting 释放执行名额，恢复重新服从容量；取消不等待无关 Task 生命周期操作。
- checkpoint、审批和 Task 输入补充具备轮次、版本与幂等恢复约束。
- Topic 引用增量合并；附件失败只按本次依据拦截。
- Observer 展示 Topic 工作流处理状态。
- Resident 的任务、话题和消息动态输入有总量预算及分页回读入口；普通阶段减少一次模型审阅。
- 两个无调用辅助函数已删除。

## 验证边界

本地 Web profile 已部署提交 `d1d035e` 的唯一 tgz，版本、进程、端口、健康接口、DWS listener/backfill 和真实群消息 E2E 均已回读。E2E 覆盖消息接收、Topic/Task 建立、叶子完成、引用回复和 DWS 回读。

首次 E2E 暴露的 `group_topic_context_get` 非 lossless JSON 错误已修复。第二轮真实 E2E 中 Resident 先成功读取 Topic revision 2，叶子 Task 再读取同一固定版本、提取标记并完成，最终引用回复由 DWS 完整回读。本轮没有发布正式版本。
