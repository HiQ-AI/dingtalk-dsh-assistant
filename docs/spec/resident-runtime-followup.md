# Resident Runtime 第二轮可靠性修复

日期：2026-09-08。源码基线：远端最新 `main`，`24a8c64ab3ac90917a3a305a669f70026e5d349e`。

本文件是实施前快照。目标是在不改变“每群一个 Resident、持久 Topic、每 Task 一个叶子 Session + Goal”结构的前提下，修复最新 main 上可确定复现的五个状态与载荷问题。

## 问题与根因

1. Topic 工具直接返回 Store/请求对象，其中可选字段保留 `undefined`；DSH 会在工具返回边界执行 lossless JSON 快照，因此业务写入可能成功而调用结果失败。
2. `progressImpact: preserve` 升级 Task `inputVersion` 时保留待审 checkpoint；旧审阅随版本失效，Supervisor 又以旧 checkpoint 版本写回，形成无法推进的闭环。首次审阅使用原提交值，恢复审阅使用含元数据值，也破坏现有请求去重。
3. completed 轮次注册的 `whenIdle` 回收只绑定 handle。立即 reopen 复用同一 handle 后，旧回调仍会移除新轮次的活跃映射。
4. 队列 pump 与人工批准/信息恢复使用不同容量检查临界区；pump 在异步创建 Session 前没有占用名额，另一入口可同时把 waiting Task 设为 running。
5. Topic 决策的必选增量先整体加入，再执行字符预算；多批消息积压时 40,000 字符约束失效。只截断消息会让模型误以为已看到完整增量。

## 设计

- 所有 Resident Topic 工具统一在注册器的返回边界做 JSON 投影，业务逻辑内部继续使用完整对象。
- Task 输入版本变化时，已确认 checkpoint 可按明确的 preserve 语义重绑定新版本；待审 checkpoint 作废并归档到执行事件，要求叶子按新版本重新提交。检查点审阅以规范化后的持久 checkpoint 作为唯一载荷，并以 checkpointId 绑定。
- 叶子完成回收捕获 `runSequence`，在任务串行区内同时核对 handle、Task state 与执行轮次后才删除映射和 dispose。
- 所有“占用 running 名额”的转换统一经过同一个调度路径；批准和信息恢复只写 `queued + resumeContext`，由 pump 串行取得容量。pump 在异步 Session 操作前先将 Task 原子标记为 running，失败时回退 queued。
- Topic 决策信封只内联预算内增量，显式给出未内联的 delta ID、总数与分页读取要求。提交仍以固定 Topic revision 校验完整 basis，模型未读取的消息不能作为动作依据。

## 验收

- DSH 原生 lossless JSON 快照覆盖 Topic 工具返回。
- preserve 输入发生在待审 checkpoint 期间后，可按新版本重新提交并只产生一条有效审阅。
- completed Task 立即 reopen 后，旧 idle 回调不影响新轮次工具调用。
- 并发上限为 1 的竞态用例始终最多一个 running Task。
- 10 条各 12,000 字符的增量不会生成超过预算的内联消息，未内联增量可通过固定版本分页读取。
- 全量测试、原 A01–A10 探针、打包、简单 Runtime E2E 和 diff 检查通过。
