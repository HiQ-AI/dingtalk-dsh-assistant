# Round 7

## 结论

单消息多事项版本已合入并部署到本地 DSH Web，实际 v7 存储已离线迁移为 v8。安装后 Runtime、DWS 监听和任务表同步均健康；停机前 52 个 Task 全部完成，因此部署未中断执行中的任务。真实群外发和生产模型冻结 gold 评测未执行，不能据此宣称真实语义质量或真实消息投递已验收。

## 代码与回归

- PR #99 已合并，merge commit `984c962c52944c2ba693fc9d864ffb0315e88e4e`。
- 实际 v7 数据预检发现附件引用使用 `attachmentId`，修复后的 PR #100 已合并，merge commit `30fd10c7e3b7009ae557380f705470fb90234ce5`。
- 附件兼容定向测试 60/60，全量测试 429/429；真实 v7 停机前预检通过，未再出现无效 `imageRefId`。

## 迁移与安装

- 停机前确认 Task 52/52 completed、active 0；仅停止已核实的 DSH Web 进程及其 launcher，未操作其他任务进程。
- 安装前备份位于仓库外 `D:/dsh_backups/message-multi-topic-20260917-2207`；v7 原文件与备份 SHA-256 均为 `BD29BCD8F66BE696532094142F12F6BB910F3F42BC848AEDC3D8AC5E742274A3`。
- v7→v8 迁移返回 `written=true`、`verified=true`；v8 文件初始 SHA-256 为 `18BD96D2E28BBE6F7F622E32651CFD206058D2BD11DBAE07F3D26FA7BC1E856E`。只读检查为 groups 1、scheduler 1、tasks 52、alerts 74、activities 10022、coordinationRequests 269、reportEvents 571，invalidRecords/strippedFields/unknownTables 均为 0。
- Assistant 包 SHA-256 为 `2060ECB67DCF159D0651A190A48B810388850E79BC4DEA6FE9143FF9D95B93E3`；Observer 包 SHA-256 为 `D30A25A398AEBB22F0DF374B883B6C3383914C5129859D14BDFCB6F6C0968B4B`。profile 已回读指向这两个唯一 tgz，关键安装源码摘要与工作区一致，`residentDomainSpec.version` 为 8。
- 现场 profile 的 `.modules.yaml` 仍指向旧 DSH_HOME virtual store，原生插件安装因此首次失败且未改 profile。停机状态下在当前 profile 执行 `pnpm install --force`，并补齐 loader 实际要求的精确 peer 后重新安装、启动成功。该预检已同步到部署 runbook。

## 运行态与外部只读回读

- 新实例 PID 778812 同时监听 3080/18998；`/health` 返回 `status=ok`、transport=dws、inboundProcessing=true、outboundAuthorized=true、modelMode=real、recoveryIssueCount=0、DWS bridge healthy。
- 运行态回读 Tasks 52、active 0；Topics total 59、pending revision/unit 均为 0；任务表状态 success、taskCount 12。
- `dws sheet +read` 完整读取 `A1:N200`：`complete=true`、`hasMore=false`、returnedRange 正确，14 列表头逐列匹配，12 条任务位于第 3–14 行，第 15–200 行均为空。
- 本轮未向真实钉钉群发送测试消息，也未改写历史消息状态；DWS healthy 仅证明监听链路健康，不证明真实外发和群内回读。

## 保留边界

- 生产模型冻结 gold 的误拆率、漏拆率、错误续接率和授权扩大率仍未测。
- 真实引用、@、撤回、附件与独立事项完成通知的群内投递/回读仍未测。
- v8 只迁移存量消息到单事项单元，不自动拆分历史已合并 Task；附件页码和文档内部位置仍使用现有粗粒度来源能力。
