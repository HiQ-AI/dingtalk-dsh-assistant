# 执行卡片展开加载

基线 main 56483462。这里只跟踪看板任务卡片内“执行会话”的加载，不把全看板或任务详情请求混为一谈。

## 请求链与问题

`CardExecutionPage` 请求 `GET /state/tasks/:taskId/executions?summary=true&offset=…&limit=10`；HTTP 转给 `getTaskSessionExecutions`，resident 绑定 `taskExecutions`，服务仅调用 `observer.page`。SQL 已先按 task_id 和本页 ID 分页，没有读取会话日志/工具轨迹，也不是先读全任务再切片。

但摘要 SQL 仍返回完整 definition 和所有 lease 的 timeline；服务继续构建该卡片不用的文档、工作区和日志路径。卡片显示的 latestRoundTiming 也没有由该分支计算出来。更直接的加载问题是 useEffect 依赖每次看板 updatedAt，刷新会取消未完成请求并清空已有数据：响应慢于刷新周期时可反复回到加载态。

## 最小修正

- 摘要 SQL 保留标题原始字段、会话身份、状态、backend、耗时所需当前 lease 段；不返回定义中的无关字段、结果正文和旧 lease 时间段。
- 服务对 summary 快速返回卡片字段，并用现有 latestExecutionRoundTiming 规则计算当前轮耗时；不调用详情路径构造。非 summary 详情继续保留原结果、定义和完整历史。
- 同一任务同一页只保留一个未完成请求，后台刷新不取消、不清空列表；换任务/页码或卸载才取消。错误保留到成功响应或页面切换，提供重试和明确空列表状态。

没有增加缓存系统、迁移或新表，也不修改通知/Topic 功能。

## 证据与验证

合成 SQL 数据：140 条执行、两个任务，每条 300 段旧 lease；请求当前任务 offset=10/limit=2，计数 40，仅物化本页 2 条、执行 ID e10/e11；返回条目合计小于 2000 UTF-8 字节，且每条仅当前 lease 段。非摘要详情的 301 段及结果正文仍完整。

SQL 仍须读取并解析被选中页内记录的 JSON；本次不声称页内零正文 IO，也不增加额外摘要持久化结构。COUNT 继续使用已有薄索引。没有采样真实任务接口，因此不声称已现场提速或确认现场唯一根因。

重复命令：
```powershell
node --test test/observer-pagination.test.js test/client.test.js test/http.test.js test/observer-client.test.js test/observer-node-control-display.test.js test/observer-slot-compatibility.test.js
node scripts/test-suites.mjs check
```

核心组最终 159/159，通过且零跳过，结果见 execution-card-core-final.log；静态 UI 严格审计 execution-card-ui-audit.json 为 0 findings。合成 Chrome 页面复用实际 CardExecutionPage 与 React：200ms 后台刷新/1200ms 请求能完成并显示列表；模拟失败显示重试，点击后恢复；切到空任务显示暂无执行记录。该页面使用合成服务/简化宿主控件和 360px 内容宽度，不能替代真实 DSH 联调、完整移动视口和原生导航验收。

本次仅本地提交供集成，不 push/PR，不修改真实库，不重启服务。

测试映射按当前源码生成：324 个文件，lane/category/release 未变，无测试删除；刷新同时消除了 main 现有的三个已移除协调模块依赖闭包，集成后需重新生成并检查映射。

## 同一 PR 整合补充

本地提交 a15af6b7 已整合为20b54b86，与固定路由类别、平台只读问询、通知分阶段调度和退休提示清理同一 draft PR。最终交叉核心结果见 docs/acceptance/notification-readback-split/final-summary.md；原线程的“仅本地提交”描述是当时检查点，整合交付仍未合并、部署或修改真实数据。
