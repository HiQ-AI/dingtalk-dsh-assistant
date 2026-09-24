# 第 28 轮：原任务流程补迁包切换到本地实例

日期：2026-09-24。只切换本机 DSH Web 的 Assistant 包；Observer、模型配置、工作流控制库、历史 Task 与渠道消息不迁移、不重放。

## 安装前

- PR #121 的源码提交 `75c1b327708fc77f7955114ea6a7db84c099fdbe`；`npm test` 为 851/851 PASS，Web client 构建退出 0。
- 旧 `/state/tasks` 为 68 条 completed；`/state/workflows` 为 `workflow-v2`，当前无活动消息或任务。旧存储只读预检：domain v9、68 Task、0 invalidRecords、0 strippedFields。
- 确认 3080 和 18998 同属旧 PID 28608，停用计划任务后停止该进程及其两个 DWS 子进程。端口不再监听；停机后备份 JSON、seal、SQLite/WAL、工件及 profile 配置到仓库外，并独立回读源/备份哈希。

## 安装与回读

- 本轮 Assistant tarball SHA256：`97665F2802AE07CF3360BBB279C19C3127489F9DDD972FE78BC0F93AB2879A8F`。使用 profile 内原生 DSH CLI 安装，依赖指向该精确 tgz；Observer 依赖保持原值。
- 安装目录 63 个源码文件逐一与工作区比较，0 mismatch。profile patch SHA256 前后同为 `18B3B6A28C4E31F97DBEC69C65164848C7EEB11203545177B5E779E9AC5CD187`。
- 首次启动计划任务返回 1：输出重定向目标目录不存在，启动脚本未执行。创建该目录并重启同一计划任务后，3080/18998 同属新 PID 43160；已将此检查补进部署 runbook。
- `/health` 为 ok、transport=dws；认证 Web 请求返回 HTTP 200。`/state/workflows` 仍是 `workflow-v2`、原 instanceId、schemaVersion=1，无活动消息或 Task；`/state/tasks` 为 68/68 completed。默认模型仍为 gpt-6-sol。
- 任务表同步状态为 success、trigger=startup、taskCount=16。DWS 对原 nodeId/sheetId 的 `A1:N200` 严格只读回读为 complete=true、hasMore=false、truncationReasons=[]；18 行有值，含标题行与任务行。未发测试群消息，未执行外部效果。

## 边界

这证明精确包安装、启动、状态保全和本机 Web/表格回读；未证明真实群新消息端到端延迟、外部平台适配器或生产任务执行。四类外部效果流程仍须在受信适配器接入并隔离验证后才可准入。
