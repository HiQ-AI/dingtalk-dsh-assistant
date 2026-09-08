# Topic 归属、动作主归属与读取预算修复

日期：2026-09-08。基线：`main@94cbfdf4afc0d680ce1a460f805606b3d8e1eff6`。

## 问题

1. Resident 会把“为了回答而需要查询某 Topic 的历史资料”当成“新消息继续该 Topic”。实际消息 #886 因需要旧 PR/分支信息，被同时归入旧缺陷 Topic 与当前展示 Topic，污染旧 Topic 摘要；后续分支讨论继续沿用错误归属。
2. 一条消息属于多个 Topic 时，Host 按 Topic 存储顺序推断唯一动作主归属。提交顺序不能改变结果，主归属可能落到较早创建的旧 Topic。
3. Topic 决策内联消息限制为 40,000 字符，但 `group_topic_context_get` 默认按 100 条返回，10 条各 12,000 字符的隔离数据一次返回 122,454 字符。超长单消息也没有分段读取协议。
4. 叶子会话原先使用 `workspace-write`，不能满足用户要求的完整本机执行能力。

## 设计

- 明确区分 Topic 归属与历史资料查询：归属只允许 `continuation`（延续同一讨论目标）或 `affected`（消息实质改变该 Topic 的事实、范围、结论或动作）。仅为了检索资料不得建立关联。
- 多 Topic 路由必须为每个目标声明 relationship 和理由，并通过 `effectOwner` 显式指定唯一动作主归属。Store 将主归属标记写入 Topic entry；后续决策优先读取该标记，历史无标记数据保留原有回退。
- `group_topic_context_get` 对完整 JSON 返回施加 40,000 字符硬上限。普通分页尽量返回完整消息；单条消息过长时返回连续文本片段及 `nextOffset`/`nextTextOffset`。只有从文本起点连续读到结尾才将该消息计为已读。
- 新建和恢复叶子会话均应用 DSH 原生 `danger-full-access` preset。Task objective、验收标准和 Agent 工作区规则继续界定业务动作范围；来源群通知仍只经 Runtime 的结构化结果链路发送。

## 验收

- #886 类型的双重关联若缺少逐 Topic 关系、理由或唯一主归属，Host 明确拒绝。
- 提交中显式指定当前 Topic 为主归属后，动作 owner 不受 Topic 创建顺序影响。
- 10 条各 12,000 字符消息的每次 Topic 读取返回不超过 40,000 字符；逐页/逐片读取后才允许决策。
- 新建和恢复叶子会话均为 `danger-full-access`，Resident 仍为 `read-only`。
- 之前 R1–R5、A01–A10 与全量测试继续通过。
