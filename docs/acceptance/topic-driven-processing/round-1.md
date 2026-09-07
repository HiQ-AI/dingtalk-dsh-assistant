# 首轮实现与反证

本轮为分模块实现及集成中的诊断记录，尚非最终全量验收。初始全量概览见 round-1/full-tests-initial.log，保留旧协议测试失败及超时的真实结果。

## 已实跑证据

- Store/迁移和 Native Inbox 使用真实 DomainFacility、JsonStorageBackend、Session、Inbox；只在独立临时目录写合成数据。
- Observer 独立 Edge 浏览器 11 项通过，原始断言见 round-1/observer-checks.md；使用真实界面代码与宿主替身，没有声称已安装 Web 验收。
- 性能配方和原始样本见 scripts/store-performance.mjs 与 round-1/store-performance.json。相同入站操作中 v7 写成本增加，不构成模型响应加速证据。

## 反证驱动修正

1. 历史 Inbox inserted 不能证明输入已消费，取消/仅claim时旧判断会漏投。投递依据改为pending或user/message，并使用原生sessions.flush耐久检查点。
2. 回复候选在模型审阅后可能更新。普通决策和Outbox写入在Store原子变换中复核；无关Topic候选不使独立Topic失效。
3. failed决策仅记录重试时间会在无新入站时停滞，新增独立到期重试定时器。
4. Web多步写入在输入与decision之间有崩溃窗口，改成一次原子写入原文、Topic、decision和Task保留项。
5. 先撤回后存通知会丢失外部副作用依据。改成Outbox先落盘，渠道prepareOutbound再幂等撤回和发送。
6. DSH原生工具JSON Schema不支持minimum/minItems等关键词；保留Zod/执行侧校验，工具描述采用SDK支持的子集。
7. 已有Task的Web请求必须显式提供topicRefs和执行版本，避免重复请求从当前Task动态推导而改变请求身份。
8. Task完成/等待必须先通过持久版本门禁，再改变原生Goal；旧输入拒绝不得先改变Goal状态。

## 实现取舍

每个新输入版本要求重新确认检查点，旧检查点归档为内部执行事件；Task不保存消息副本。Resident直写Task工具被移除，群消息统一经Topic决策及原始依据校验；Web入口仅接受真实人工请求。

各Topic独立提交与恢复仍共享每群一个Resident模型资源，不声称同群模型并行。已接受意图的持久化与外部投递分别验证，ack不替代DWS读回。

## 未完成边界

最终全量回归、真实DSH+fake transport集成、打包及PR尚在进行。未使用真实群消息开展语义标注、未迁移实际profile、未发送真实DWS测试消息。矩阵待后续轮次填入可追溯证据。
