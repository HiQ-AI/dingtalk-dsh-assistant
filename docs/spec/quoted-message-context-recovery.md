# 引用消息上下文恢复方案

## 目标

群成员通过钉钉引用回复时，Resident 优先使用常驻会话中已经收到的原消息，Steer 信封继续只传引用消息 ID，避免重复注入正文。如果原消息因传递异常、会话恢复或上下文压缩而不在当前可见上下文，Resident 必须使用 DWS Skill/CLI 按稳定消息 ID 主动取回，并递归取得被引用消息继续引用的全部上游消息。不得把上下文恢复成本转给群成员。

## 现场根因

2026-09-03 的消息 `msg1S1pGYsxezWBRTO0AOgGDQ==` 引用了 `msgwHRv/JR4wGotbnrFmqC8bQ==`。后者又引用原始业务消息 `msgsmBLH5zCGBAf3kuMSsukJg==`。真实 DWS `+messages-mget` 回读完整返回了两层正文和原始图片资源，但 Resident 直接回复“没拿到引用消息的正文”。

当前只规定 Decision 信封保留引用 ID，却没有规定上下文缺失后的恢复动作。Resident 因而把“当前可见上下文里没有”错误等同为“DWS 无法取得”，既没有加载 `dingtalk-chat` Skill，也没有执行只读消息详情查询，更没有沿返回的 `quotedMessage.messageId` 继续追溯。

这次不是 DWS 数据缺失，也不是 Store 丢失直接引用正文；根因是群决策协议缺少强制的引用链恢复步骤和失败边界。

## 方案

### 1. 保持 ID-only 信封

- `buildDecisionPrompt()`、群历史导入和叶子来源信封继续只传 `quotedMessage.messageId`。
- 不把 DWS 事件内嵌正文无条件重复注入每个 Steer；正常情况下，原消息已经位于同一常驻会话上下文。
- 引用关系只用于定位上下文，不自动构成新 Task、扩大目标或变更授权。

### 2. Resident 主动递归恢复

群决策系统提示增加不可跳过的恢复协议：

1. 收到引用消息 ID 后，先在当前可见会话上下文与本群任务索引中按 ID 定位；
2. 无法准确还原正文时，先加载 `dingtalk-chat` Skill，再通过 `pwsh` 调用：
   `dws chat +messages-mget --msg-ids <ID> --profile <当前插件profile> --format json`；
3. 检查 `complete`、`failedCount`、`failures`、`foundCount` 和 `notFoundMessageIds`，不得仅凭退出码判断已取回；
4. 如果返回消息仍有 `quotedMessage.messageId`，继续查询该 ID，直到不存在更上游引用；用已访问 ID 集合检测循环，不设固定层数截断正常引用链；
5. 上游消息含图片或文件且承载目标、范围、对象或验收信息时，按 `dingtalk-chat` Skill 的资源读取流程取得并阅读；
6. 恢复完整链后，才结合任务索引和近期消息提交 Decision。

所有查询显式使用插件配置的稳定 profile，避免 DSH Shell 的默认 profile 与订阅身份不一致。

### 3. 失败时不打扰群成员

- DWS 查询失败、返回不完整、消息未命中或引用链发生循环时，不得提交“请补原问题/截图/正文”之类群回复，也不得猜测业务结论。
- Resident 保留工具错误并结束当前 step，不调用 `group_decision_submit`；Runtime 现有未提交收敛机制会将该消息标记为 `decision-failed`，保留在本地供恢复后显式重试。
- 这一区分保证“外部上下文暂时不可读”是内部可重试故障，而不是业务群成员的信息补充义务。

### 4. 叶子会话保持同一规则

叶子来源信封如果只有引用 ID、而完成任务需要该引用内容，也执行同一递归 DWS 恢复协议。叶子不得用主会话生成的摘要替代原消息，也不得因引用查询扩大 Task objective。

## 验证矩阵

1. Decision 信封仍只包含引用 ID，不重复正文。
2. Resident 和叶子系统提示均包含 `dingtalk-chat`、`+messages-mget`、同 profile、结果完整性检查和递归终止条件。
3. 提示明确禁止在 DWS 恢复前或恢复失败后向群成员索要被引用正文。
4. 提示明确要求查询失败时不提交 Decision，使消息进入既有 `decision-failed` 可重试路径。
5. Runtime 设置 profile 后，已有与新建 Resident/叶子都读取动态的同一稳定 profile。
6. 原有引用转交门禁、Task 来源校验、出站引用回复和 DWS 回读校验保持通过。
7. 使用本次真实消息 ID 独立运行 `+messages-mget`，确认可从追问恢复到 Agent 回复，再恢复到原始业务消息与图片资源。

## 非目标

- 不把引用正文复制进每个 Steer 或持久化新的引用链副本。
- 不让 Runtime 代替 Resident 无条件查询所有引用消息。
- 不主动向真实业务群发送测试消息；部署后的真实 E2E 等待自然产生的引用追问并回读验证。
