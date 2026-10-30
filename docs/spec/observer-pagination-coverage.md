# 看板真分页实现与验证检查点

本清单保留分页阶段的入口与读取边界记录，现已整合到main `644ff90c`之上。当前核心验证和已知限制以 `local-performance-integration.md` 为准；下文历史阶段测试及合成宿主记录不等同本轮最终运行，也不等同真实DSH部署验收。真实迁移、真实安装版本和完整DSH宿主验收未进行。

## 已接通的当前动态任务看板路径

| 页面/集合 | 实际读取边界 | 验证 |
|---|---|---|
| 任务列、归档、主题关联任务 | observer_task_index/observer_task_topics 计数与排序；MATERIALIZED 页内 ID 后读取任务正文；移除 dialogue；归档页不统计执行数量，混合页只统计未归档项；每页默认 10/20/10 | 1000 条合成任务、稳定同时间排序、跨页修改拒绝、归档/取消/人工等待/执行状态触发器、SQL covering count、归档页禁止读取执行索引而详情仍按页可达 |
| 卡片执行历史 | observer_execution_index 顺序+ID；先页内 ID 后提取摘要，不返回 prompt/result | 22 条选择末页；真实卡片下一页浏览器交互 |
| 群消息 | 持久 SQLite 展示行；SQL WHERE/ORDER BY/LIMIT/OFFSET，GET 不查询来源/日志/决策历史；提交后更新相关 message IDs | 1000 条 SQL 分页与状态筛选、单条增量、重启持久性、失败对账、过期页拒绝 |
| outbox | 独立 ID/状态索引，选页后返回；不查询群消息 source 表 | 125 条分页；服务端分类与原 UI 多组合语义一致 |
| 授权列表 | observer_human_index 排序计数；选择页内 request，JSON 仅提取该请求与准确 operator notice | 53 个请求中选择单个请求；授权详情不依赖当前页 |
| 主题列表 | 元数据版本/ID 缓存，按页解析主题；不同群/全局缓存互不作废 | 浏览器主题第二页；旧列表和话题切换回归 |
| 当前话题消息/intent/关联任务 | topic refs 元数据选择后投影消息；intent 有 offset/limit；关联任务 SQL 分页并包含归档 | 原主题/上下文回归；浏览器消息来源第二页、关联任务第二页 |
| 协作来源 | createdAt+ID 索引，LIMIT/OFFSET 只返回本页正文 | 真实合成 SQLite HTTP/只读状态比较 |
| 协作工作列表 | 狭窄 SQL 元数据投影、版本缓存，页内工作摘要；排除执行 prompt/result、receipt 快照、完整 source 正文 | 保留 66 项协作领域断言；真实 SQLite 接线 |
| 告警 | ID/类型元数据分离，页内生成正文；保留持久化协作失败告警 | 页面第二页与现有业务断言 |
| 消息 trace | 独立 trace ID 索引，包含共享 IB 去重与 coordinator；最多 100 个选中事件再读取正文；coordinator有效unit独立每页100（另1条lookahead），先过滤superseded | 1000 nodes+共享项，仅读取 10 条正文、无临时排序、版本变化拒绝 |
| 旧 workflow 混合主题列表 | 窄索引排序/过滤/总量，选择 ID 后只展开页内主题；同时间保留原集合次序 | 1000项 metadata 只调用10个正文 provider；旧全量provider不被调用而明确503 |
| 旧 workflow 主题来源 | source/fact-reference 窄索引，MATERIALIZED ID 后读取当前 source body；pageRevision变化拒绝 | 1000来源只读10正文，去重、fact失效、source版本切换 |
| 旧 family executions / runs | family权限/总数/排序及页ID在SQL；runs最多limit+1条元数据，页内当前节点摘要 | 1000记录数量边界、组/web权限、同时间排序、循环/悬空family、归档/reset、变化409 |
| 只读 LegacyTaskHistory | 显式服务端legacy-history页；adapter executionPage仅页内run/节点引用，0 artifact正文 | SQL与UI契约测试；当前dynamic resident不绑定旧库provider，缺能力明确503 |
| 输出/证据文本 | SQL最多4个4096-unit块；artifact最多3个8192B文本块+8192B header+每块O(log块数)个32B证明，原JSON正文0读取 | 可信ledger root、整体sidecar篡改、跨消息、Unicode、cursor/hash、原文件变化、重启、显式离线回填 |


收件箱投影保存在任务库旁 <dbPath>.observer-inbox.sqlite，仅含展示字段和恢复标识，可从权威数据重建。每次启动一次对账（来源窄字段每批最多100条，不读取 stages、resources、路由或通知全文），只写实际变化行，修复跨库提交中断；运行中消息、话题决策或来源提交只重投受影响消息。GET 不构建索引，不因轮询或缓存失效全群聚合。原 Resident 消息内存存储保持；主题/告警等其他索引的既有成本不属于本次优化，深 offset 遍历成本仍随 offset 增加。独立协调工作及来源 API 已退役，表中相关项仅为历史记录。

## 稳定性与交互

显式 limit 边界 1..100；排序包含 ID 决胜。数据库页使用实例+变更版本，内存页使用独立版本；旧页请求遇数据变化返回 409，客户端回第一页，避免默默重复或漏项。轮询与慢响应按请求键去旧；跨页加载、空数据、错误分别显示。当前只请求活动栏目；切页/筛选/栏目切换取消旧请求，刷新失败保留原列表。历史条件语义保持，旧provider不能满足存储分页时明确升级错误，不把全量兼容fallback伪装成分页。

## 实际执行的验证

本轮收件箱对比使用同一云端合成库：1000 条消息、每来源40条隐藏诊断、每页10条。稳定 GET 中位耗时 9.18ms → 0.29ms，p95 12.53ms → 0.62ms；查询次数10 → 3，SQL返回字节2723336 → 4792，响应体193356 → 4434字节。新持久投影首次启动对账195.83ms单列，不计入GET；这不是百部现场或真实模型性能。浏览器验证10/10/4分页、空筛选、刷新失败保留、切页取消旧请求及390px局部滚动，0 page error。独立审查与相应恢复回归覆盖投影失败后对账、初始化失败释放资源、晚到通知回执移除回流消息。

- `pagination-final-regression-21.log`：419/419 通过；包括仓库规定的 5 个 premium UI 单元文件，以及新增分页、迁移、协作、存储、工作流和看板交互回归。此次为当前 SQL 页内 ID 收紧后的结果。
- `pagination-ui-loading-19.log`：43/43 通过（修复初始化 undefined 集合误用及加载占位断言）。
- `pagination-final-boundary-20.log`：78/78 通过；与整组回归有重叠，不应相加。
- `node scripts/test-suites.mjs check`：318 文件，每文件恰好一次，historical 3/deleted 0。
- 严格 UI 审计：`scratch/pagination-audit/result.json`，0 findings（早于最后加载文案与 SQL 修正，需最终重跑）。
- 浏览器：实际 web-client 源码 + React 18 + 简化 DSH 组件宿主 + GET-only 合成 API。验证群消息/outbox/任务列/执行历史/归档/授权详情关闭/告警/主题/来源/关联任务翻页、过滤、空/错误/400ms 慢响应、390px 无水平溢出；不是完整 DSH 宿主或真实服务联调。最终 reload 首屏出现“正在读取群聊消息”，随后 63 条/每页10、1/7，新增浏览器 error 日志为空。

## 离线迁移

`observer-pagination.js`、`observer-trace-pages.js` 只在全新库或显式离线迁移建表/索引；GET 不隐式迁移。`scripts/migrate-observer-pagination.mjs` 默认为只读检查；apply 要求单独一致性备份、源库/备份精确 SHA、无非空 WAL、无 active owner，并持有排他锁；legacy trace 额外获取 owner sidecar 锁。2 项测试实际只操作系统临时目录中的合成库，覆盖备份不变、错误 SHA/owner/WAL/锁拒绝和原子迁移。未对真实快照或在线库执行迁移，未测真实迁移时间、空间与业务恢复。

## 兼容边界与未验证风险

- 旧 workflow 仅全量 topics 的 provider 返回503 `workflow_topic_pagination_provider_required`；新适配绑定 service.topicIndex/topicById。generic topic context 不再回退全任务list/HTTP intent slice；native reader需listTaskPage。LegacyTaskHistory缺页provider明确503，不自动打开旧业务库。当前dynamic生产facade没有这些旧workflow/history绑定；合成provider测试不能冒充旧生产链联调。
- 缺 observer SQL schema、artifact页或可信binding的旧数据明确要求离线迁移。部分schema明确拒绝而不误报ready；GET不建索引、回填或改文件。旧workspace/generation输出缺必要context不伪造事实，分页503，显式回填需相同context；完整document下载保留原读取与上下文恢复语义。
- 文件派生索引有实际空间代价，未跨run去重或压缩。合成168000 UTF16 units：原artifact176014B，显式两个view约680844B；SQL原source已存在时allocated pages196608B→425984B，增加229376B。非真实库预测，不包含日志/备份开销。默认inputs/receipts不建无用sidecar。详见 observer-file-pagination.md。
- 离线文件回填不是跨文件事务：失败会回滚DB binding，已写sidecar可残留；--rebuild失败可暂时使旧binding与manifest不匹配，GET会拒绝。保持服务离线、修复原因后重跑，不能把部分回填当成功；原artifact/精确DB备份保留。
- 非分页detail的任务timeline、协作详情/单来源详情仍有全部相关历史读取。每个分页实体的嵌套stage/关联历史可能大于页长，元数据冷构建、深offset、轮询全局Promise.all仍有成本。本任务没有证明所有首屏慢路径或数据库体积问题已消除。
- 最新浏览器重验真实web-client源码：群消息2/7、主题初始化及来源第2页，0 console error；合成API/简化DSH宿主，fixture和标签页已停止/关闭。没有真实DSH宿主、真实安装版本、9.6GB快照的性能或迁移验收。

## 最终验证证据

- `pagination-final-integration-37.log`：680项，679通过、1失败、0跳过；唯一失败是Windows合成manifest显式replace的rename EPERM。之后实施最小有界重试并通过75项相关联合回归，详见下一条；原整组结果保留。
- `pagination-file-permission-final-38.log`：权限升级单文件10/10通过，但不足以单独判定EPERM根因。已复核无已知文件handle/cleanup竞态；现仅Windows显式替换的EPERM/EBUSY/EACCES有最多1000ms等待预算，最终保留原错误，不删除目标或放宽校验。child-16专门13/13通过，含真实Windows共享锁；修复后 `pagination-final-recheck-39.log` 联合文件/HTTP/trace/迁移/workflow回归75/75通过、0跳过。未重新运行整个680项组，不能把旧日志改写成680全过。
- `pagination-artifact-pages-child-12.log`：132项130通过/2个新增file fixture失败；其中完整execution-store104/104通过。旧fixture(view及instanceId)修复后child-14独立file10/10通过。后续最终测试以明确日志为准，历史失败不隐藏。
- `pagination-premium-final-36.log`：规定5个UI文件138/138；`pagination-material-profile-35.log`：使用本机已安装profile只读依赖+合成数据/ScriptedModel，15/15；没有真实业务模型/数据库操作。
- `pagination-work-proof-32.log`74/74，`pagination-context-contracts-29.log`79/79，`pagination-last-local-31.log`84/84，`pagination-final-meta-33.log`8/8。各组有重复，不相加。
- 测试清单320文件，每文件恰好一次；historical3/deleted0。严格UI审计 `scratch/pagination-audit/result-complete.json` 0 findings。最终git diff --check通过。所有验证仅本地，无提交、推送、部署或真实库迁移。

## 后续验收指标

本轮验证页内读取、稳定排序/409重置、过滤与总量以及加载/空/错误状态；已做1千/1万消息的合成HTTP基准，不将10万数据或真实DSH验收作为提交PR前置，不用合成浏览器延迟推断生产性能。


## 独立审查 P2 收口

仅修复 coordinator unit 静默丢证据和证据回填全量内存读取两项。

- coordinator unit 的 `status != superseded` 在 SQL LIMIT 前执行。100个失效unit后的第101个accepted单元不会丢失。超过100个有效unit时，`coordinatorUnits` 返回总数、本批返回数、完整性、独立nextCursor；`unitCursor`不改变trace事件游标。续读必须携带pageRevision，变化409。TraceDetail显示有效单元摘要和“上一批/下一批协调单元”，跨事件/消息及409清空unit游标。125有效unit的100+25页无重复遗漏，UI合成浏览器已验证第二批101..125及明确最后一批，0 console error。
- evidence离线回填固定高水位rowid，每次.all最多32条，批次完全读完后才写派生表，不持有活动iterator。SQL仅选含文本snapshot的run，以及所需material/node共享来源/agent-execution绑定kind。合成测试确认50个合格run、195个合格item被解码，400个无关kind和65个无来源node等被跳过，最大批32；最终180个text、130个bindings语义保留。
- 32是记录数上界，不是字节上界；单条JSON/引用集合大小仍影响峰值。仍保持离线排他原子事务，总扫描/写入及事务时长随合格数据规模增长，未做在线或真实大库迁移测量。
- `pagination-p2-focused-43.log` 18/18；`pagination-p2-final-44.log` 174/174、0跳过（包括规定UI、HTTP、trace、文件/迁移与workflow）；最后跨消息unit游标重置后 `pagination-p2-ui-final-45.log` 140/140。初始41/42日志中新增测试重复import导致模块加载失败，已修正，保留日志，不计为通过。
- 浏览器仍为实际web-client源码+React合成宿主/API；不能冒充真实DSH联调。原679/680及75复验的历史记录不改写，也未重跑完整大集合。
