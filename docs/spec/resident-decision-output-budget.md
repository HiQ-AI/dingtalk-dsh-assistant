# 常驻 Topic 决策输出收敛

## 现场与目标

2026-09-21 的一次 `group_topic_route_submit` 返回 54,270 字节：本次只有一个事项增量，返回中却包含 32 个历史事项片段、54 项归属映射，以及多次重复的引用正文。首屏上下文由本次增量优先、再填满历史的策略产生；路由工具还把同一批待决策正文作为结果返回。

目标：路由提交只产生有界回执；决策请求的首屏只带完整本次增量、直接引用和摘要；超预算内容通过固定请求续读，授权依据的完整性仍由 Host 检查。一个 Topic 的补读不能阻塞另一个 Topic 的独立提交。

## 协议

1. `group_topic_route_submit` 成功回执只有 `status`、`requestId`，恢复提交补 `recovered`。正式 Topic ID 只从相应 `[GROUP_TOPIC_DECISION]` 获取。`topic-stale` 返回短指引。路由、决策数据仍由 Store 保存，不依赖工具回执。
2. 决策首屏包含固定请求标识、Topic 标题与摘要、本次全部事项的原文及必要来源信息、直接引用、动作主归属、未读增量指针和历史查询指引。历史默认不展开。所有模型可见列表按字节预算分页。
3. 新工具 `group_decision_context_get(requestId, section, offset)` 只读取当前群固定请求的内容段。段由 Host 生成并返回指针；输出记录 `offset`、`nextOffset`、`totalChars`、`hasMore` 和内容指纹。历史仍使用 `group_topic_context_get`。
4. 首屏和工具读取均按完整 UTF-8 序列化结果计费：路由回执 1 KiB、决策首屏 12 KiB、每次续读 12 KiB。超额只转成指针，不切断 JSON。
5. 首屏进入 Session 或续读结果处于当前 surface 时才标记相关增量为已读。压缩或重启后如果缺少当前可见依据，要能重新发送首屏或按指针续读。提交仍按冻结的 `unitId + unitRevision`、Topic 版本和动作主归属校验。

## 实施位置与验证

- `topic-runtime.js`：回执、紧凑投影、预算、续读、读取门禁与恢复。
- `coordination-context.js`：当前 surface 的决策正文和续读页可见性判定。
- `runtime.js`：状态查询基于必读增量的完整性，不以历史总量判定。
- `fake-llm.js`、相关测试、README 和部署说明：同步新协议。
- 使用现场输出统计与构造的百条历史、超长引用、多事项授权、跨群、过期、压缩、重启、独立反馈用例验收。部署前还须检查本机正在运行的 Task，避免中断。
