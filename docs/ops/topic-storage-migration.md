# Topic 存储迁移与回退

本次存储 domain 从 6 升为 7。新 Runtime 不能直接打开旧介质，禁止只修改 JSON 中的版本号。当前工具只支持已核验的 `@deepseek-ai/dsh-storage-json@0.1.1-rc.2` 后端；该 SDK 每个 unit 保存一个包含 `unit`、`global`、`tables` 的 JSON 文件。其他后端必须另行实现并验收，不能套用文件迁移。

迁移工具不启动 Runtime、不调用 DWS、不执行 Task。所有操作均写到明确指定的独立目标。原介质和配套 Session 检查点作为回退依据保留。

## 前置条件

1. 从当前 profile 的配置确定 JSON backend root，找到 `dingtalk_dsh_assistant.json`。不要猜默认路径。
2. 在已安排的停机窗口停止所有写入该 domain 的进程，保存旧代码版本、完整配置、原存储和匹配的 Session 检查点。运行服务时仅可对一致性副本做实验，不能据此直接切换。
3. 在本仓运行 `pnpm install --frozen-lockfile`，确保迁移工具使用锁定的 storage JSON 与 domain SDK。
4. 为新版本选择独立目录。目标文件名必须是 `dingtalk_dsh_assistant.json`，不得与源文件相同或指向同一文件。工具不覆盖不同内容的已有目标；失败产生的部分目标保留供检查，重新实验应指定新的空目录。

## 检查和生成

以下路径是需要替换的示例。先检查，确认输出 `ready: true`、数量和映射合理后，才执行第二条命令。

```powershell
node scripts/migrate-topic-storage.js --source 'D:/migration/v6/dingtalk_dsh_assistant.json' --target 'D:/migration/v7/dingtalk_dsh_assistant.json' --check
node scripts/migrate-topic-storage.js --source 'D:/migration/v6/dingtalk_dsh_assistant.json' --target 'D:/migration/v7/dingtalk_dsh_assistant.json'
```

`--check` 只读取文件并在内存中验证，不创建目标目录。报告包含群、消息、Task、Topic、Outbox 数量、Task→Topic 映射和问题类型，不包含原始聊天正文。缺失消息、快照正文冲突、跨群缺失、未知表、无法验证的新记录以及旧 `decision-commit-failed` 都阻止生成；必须先核对原始事实和实际副作用，不得把它们直接标成可重试。

生成先以排他方式一次写入完整目标文件并同步到磁盘，再通过真实 SDK 重新打开目标，逐表比较读回结果，并检查源文件字节未改变。目标必须不存在；这样避免 JSON SDK 逐记录 `put` 反复重写整个 domain，并规避 Windows 大文件连续原子替换的失败窗口。成功返回 `verified: true`。对完全相同的目标再次运行返回 `written: false`，不会产生第二批 Topic；不同目标内容会明确拒绝。

## 数据转换

- 每个旧 Task 生成一个稳定 ID 的迁移 Topic。Task 只保存 `topicRefs`、`inputVersion: 1` 和执行信息；删除 `sourceMessageId`、`triggerHistory`、`messageHistory`、群消息 `relatedContexts`。
- 原始 Group 消息优先作为事实来源。只在 Task 快照存在的原文迁回 Group，并标记 `sourceKind: migration`；不同副本的冲突不会自动择一覆盖。
- Web 与内部补充迁为明确类型的输入，不伪造钉钉发送人或回复能力。
- 历史轮次引用迁移基线，标记 `migrationBaseline: true`；这表示历史可追溯范围，不能当成已经精确还原每轮读取顺序。
- 未处理消息仍处于待归类状态。历史已处理消息不自动重新执行。已发 Outbox 保留 `outboundId`、业务键、`deliveredMessageId` 和渠道状态，不因迁移重新发送。
- 旧结果通知的业务键若精确匹配当前 Task 结果，补充标准化结果的 `resultFingerprint` 和 Task 关联，用于统一的结果幂等查询。相同等待原因但问题已改变会产生不同指纹；不匹配当前结果、缺少可验证结果或没有通知记录时，不猜测或生成回执。

## 切换及回退

1. 在新代码与隔离目标上完成只读启动核验，确认群、Task、Topic 关联和 Outbox 已发状态；再按当前 profile 的运维步骤切换配置和启动。迁移脚本不会代替此操作。
2. 真实 DWS 入站、引用、@、附件恢复和叶子投递需分别验收；隔离存储测试通过不等于这些业务链路通过。
3. 新版本尚未发生外部动作时，可停止新进程，恢复旧代码、旧存储路径及匹配 Session 检查点。
4. 新版本已发消息或执行 Task 后，先保存新介质和动作回执、完成对账，再决定回退。恢复旧文件不能撤销外部动作，直接启动旧进程可能重复执行。

本地隔离验证命令：

```powershell
node --test test/store.test.js test/topic-store.test.js test/topic-migration.test.js
```

测试通过真实 JSON SDK 验证独立目标和原介质版本回退可读。没有迁移真实 profile，也没有对外发送测试消息。
