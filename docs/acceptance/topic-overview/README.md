# 话题轻量总览验收

基线：`bd8640b`（main）。只调整话题页面和直接读取路径，无部署、数据迁移、调度或消息发送。

## 展示与读取边界

- 保留群聊筛选、固定分类、业务话题真实分页（10/页）。原页没有全文搜索，本次未新增搜索控制。
- 默认只展示名称、当前摘要、最近更新时间和关联任务状态。删除外层重复的 100 话题预取；所选话题不再默认读取消息页与上下文 API。
- `/state/topics?view=overview` 的当页投影不遍历 entries/decisions；详情同视图只返回当前核心字段。原接口默认行为继续兼容。
- `/state/tasks?...&view=summary` 必须带分页。复用原主题关联/归档索引，先 MATERIALIZED 页 ID，再在 SQL 选择 taskId、title、state、archivedAt、updatedAt，不读取执行详情或计算执行计数。当前和归档任务都可达；没有逐话题/任务 N+1 查询。
- 消息记录展开后每页 25 条；初次沿入口的消息版本，刷新读取最新版本。判断记录展开后每页 10 条，先切片再倒序，状态更新也使页版本失效。两种历史不跟随总览轮询重置，收起/切对象取消请求。
- 慢请求跨同查询轮询复用；切话题、群聊、页码才取消。失败保留上次正文，原位重试。轻量状态槽与背景刷新不清空内容；720px 以下选择列表独立限高 360px，总览自然滚动。

## 自动验证

实际运行：

```powershell
node --test test/observer-client.test.js test/observer-pagination.test.js test/task-topic-context-http.test.js test/observer-group-pages.test.js test/fixed-topics.test.js test/observer-slot-compatibility.test.js
```

101/101 通过。覆盖 SQL 投影/归档/版本冲突、无历史读取的 getter 断言、当页正文读取数、API 跨群边界、历史保留、慢请求复用、失败重试、取消和迟到响应隔离。

`premium-ui.json` 规定的 5 文件与上述相关文件合并回归：208 项，185 通过、23 失败。在独立未修改 main worktree、相同 Node/依赖环境重跑同一组合：202 项，179 通过、相同 23 失败；没有新增失败。失败为既有 client 模型保存断言 1 项、HTTP 恢复/协调/旧 topic provider 断言 6 项、已退役协调 UI/关系断言 16 项。本 PR 未删除或绕过这些断言，也未扩张到其修复。

额外验证：变更 JS 的 `node --check`、`git diff --check`；DESIGN.md lint 为 0 errors / 0 warnings；Premium strict audit 为 0 findings。observer 与 assistant 包实跑 pack（原始 JS 发布包无独立编译步骤）。未运行 CI，未部署。

## 浏览器

系统 Chromium + React 18、实际 observer 源码与真实 handleRequest/Resident/SQLite 查询，宿主按钮/Menu 用隔离适配器。所有数据为合成记录。

- 进入指定话题仅 4 次页面请求：固定分类、10 项话题列表、所选话题 overview、10 项关联任务 summary；全局宿主仍有 health/groups 请求，未算入该 4 次。
- 话题 23 条（10/10/3），任务 13 条（10/3），消息 53 条（25/25/3），判断 24 条（10/10/4）；后续页和最后一页可达。
- 键盘 Enter/Space 展开，任务入口、空群/固定分类入口、刷新保留两种历史所在页。
- 挂起实际请求验证连续 4 次轮询仅 1 个 in-flight；返回 503 后保留内容并可重试；切话题后迟到响应不能覆盖新话题。
- 1280px 与 390px、主题变量/减少动效检查；390px 无横向溢出。0 page errors。

这些是隔离浏览器验证，不是实际 DSH 原生宿主、真实钉钉、本机安装或完整无障碍验收。截图仅用于本地检查，未附到 PR。

## 可复现查询测量

```powershell
node docs/acceptance/topic-overview/measure.mjs > /tmp/topic-query-measurement.json
```

Node v24.19.0/Linux；相同 SQLite 合成库 120 个任务（60 当前/60 归档），每任务包含约 216 KB 非展示历史，offset=50、limit=10。交替比较原任务页与 summary 页。每种 8 次新连接首次读取（未清 OS 缓存，因此不称真实冷盘），再显式预热各 1 次，交替重复各 40 次。SQL/字段投影/JSON.parse 与响应 JSON.stringify 分别计时；无网络或人为等待。

| 测量 | 原任务页 | summary 页 |
|---|---:|---:|
| 首次连接查询 median / p95 | 12.39 / 16.29 ms | 3.47 / 7.38 ms |
| 重复查询 median / p95 | 9.44 / 12.78 ms | 1.99 / 2.85 ms |
| 重复序列化 median / p95 | 6.07 / 7.73 ms | 0.010 / 0.015 ms |
| SQL 返回正文 / HTTP JSON 大小 | 2,162,650 / 2,163,397 B | 1,220 / 1,317 B |
| 每次 SQL 语句数 / 实体行数 | 6 / 10 | 6 / 10 |

证据说明收益来自省略历史字段及执行计数、减少序列化和传输，而非减少分页总数、缓存结果或延时遮挡。SQLite 仍需读取并解析所选任务的 JSON body；本改动不提供独立持久概要表。topic 列表首次/源变更时仍重建窄 ID/排序元数据索引；无逐页全历史正文聚合。

不能把这些小样本视为百部本机加载时间或稳定性结论。共享数据库排队、health/groups、真实数据分布、原生宿主解析/渲染需本地另测。用户上传加载截图解析成功但下载失败，未取得实际像素；本 PR 不声称定位或修复该截图中的具体共用加载组件。

## 并行边界

基于 main 独立分支，不合并 PR308，不改任务详情导航、任务卡 Topic 名称、阶段记录折叠、Route/Decision/mentions。共享文件为 web-client.js（本次仅话题组件和重复预取）、task-session-service.js、DESIGN.md/UX-CONTRACT.md、test/observer-pagination.test.js。后续合并须保留 PR308 对同文件其他区域的修改。

已回读 PR308 最新 patch：`boardTasks` 的 `const page = await query(...)` 与 `return` 之间是直接重叠点。本次 `if (options.summary) return page` 应位于 PR308 的 `const titles = new Map()` 之前，普通看板路径继续保留 `taskTopicRefs(task, titles)`。web-client.js 的任务导航/阶段记录/Topic 名称区域不在本次修改范围，不能用整文件覆盖。
