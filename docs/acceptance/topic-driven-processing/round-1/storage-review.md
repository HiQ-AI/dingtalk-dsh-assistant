# 存储与提交边界审查

本记录为实施中的存储专项结果，不替代全链路验收。2026-09-07，隔离工作树执行。

## 已修复并验证

1. **跨路径撤回竞争**：历史回复在真正撤回前仍是 active，候选过滤不能替代持久占用。Store 在 `acceptTopicDecision` 与 `appendOutbox` 的原子 Group 转换中同时检查 pending Outbox 和未完成 Topic decision 的替换目标，冲突返回 `reply-busy`；自身 decision 可以追加自己的 Outbox，业务键重复仍幂等。
2. **退订丢失未发通知**：即使 Topic 决策已完成，只要 Outbox 仍 pending，`removeGroup` 返回 `group_has_pending_outbox`。关联 Task、未完成 decision 的来源保护继续保留。
3. **Web 输入崩溃缺口**：`submitWebTaskInput` 将原文、Topic、已接受意图、预分配操作身份和 Task 保留项放到同一次 Group 更新。故障注入确认持久写失败时内存和介质都保持原样；重开同请求返回原记录。
4. **固定上下文与附件**：消息事实补齐保留旧版本；相同引用的空正文不覆盖已知正文，换引用 ID 不继承旧身份。固定 Topic 版本不暴露后来摘要和关系记录。

Task 更新全部经同群短队列，真实 SDK 还在 domain 持久写队列内执行同步 transform。Runtime 把 Task/Topic 输入前提检查放到 `updateTask` 的 transform 中，可与来源更新形成正确的提交顺序；不能在 transform 中等待外部操作。

## 原生 Inbox 证据

使用真实 `Inbox`、`Session`，隔离文件保存原生 header/events、fsync 后通过 `Session.fromRestore` 重开。验证 pending、已进入 `user/message`、取消、仅 claim 四种状态。历史 `inserted` 命中不能证明输入已消费；`user/message` 的消息 ID 位于 `event.data.id`。该测试不冒充真实 profile 的 persistence plugin 或真实模型阅读。

## 已交由 Runtime 主实现处理的发现

- Outbox 返回结构化拒绝后，不能继续应用需要确认的 Task 动作。
- Task durable CAS 拒绝时，不能已经改变原生 Goal 为 complete/block；应先持久成功再调整 Goal。
- 定向他人的原始消息检查应覆盖所有 Task 副作用动作，不能仅限创建。
- Web 请求不能从当前 Task 动态派生幂等 fingerprint；同请求重试须使用明确、稳定的 topicRefs 和执行版本。
- 结果通知还应核验当前 Task state/result，防止同 inputVersion 下恢复运行后仍发送过时等待通知。

这些 Runtime 项的最终验证由主实施轮次记录，不在本记录中声称已全部闭环。

## 本次实跑

```powershell
node --test test/store.test.js test/topic-store.test.js test/topic-migration.test.js test/topic-native-inbox.test.js
```

结果：**37 tests / 37 pass / 0 fail / 0 skipped**。包含真实 JSON SDK 独立迁移读回、原介质不变与版本回退可读，未使用真实 profile 或发送群消息。

性能数据见同目录 `store-performance.json`；脚本位于 `../scripts/store-performance.mjs`。相同 40 条合成 ingest，v7 增加 Topic 与决策后的存储耗时和介质体积均高于 v6；数据不证明模型响应提速，也没有据此宣称性能 SLO 通过。

## 结果通知迁移补验

补充通用 Outbox `resultFingerprint`。迁移只在旧业务键精确匹配当前 Task 的有效结果时回填标准化结果指纹和 Task 关联；保持所有旧业务键及渠道回执。旧 waiting 原因相同而新 questions 不同时，标准化结果指纹不同；不匹配的旧消息与不存在的通知不生成猜测回执。

上述同一命令再次实跑：**40 tests / 40 pass / 0 fail / 0 skipped**。新增验证覆盖已发送旧等待通知的指纹读取、新问题区别、未知旧回执不误认，以及新字段经真实 domain schema 写入后重开仍可读取。
