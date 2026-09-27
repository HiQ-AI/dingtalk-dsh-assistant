# 第43轮：重复观察修复与现有 UAT 业务重验

## 范围

承接第42轮部署后发现的 Owner 回归。用户明确选择现有 dataset UAT3、dataset-web UAT2 的真实业务验收，不重新构建部署两条流水线。

## 已完成的隔离验证

- 部署脚本从脚本位置解析源码；支持精确 ID/revision 的 draining 维护接续及 HoldMaintenance。PowerShell 24 项断言通过，包含许可版本、ID、PID、排空、阶段变化的拒绝用例。
- HTTP 与原生 Owner 会话原有定向测试 27/27 通过；日志 `docs/tmp/round43-http-session.log`。
- 活动库只读盘点 11 个 Owner，只有两条已完成任务满足恢复条件；9 个取消任务不适用且保留历史记录。
- 数据副本中使用原生命令恢复两条任务，再重启并重复 observe，均保持 idle/complete，事件不增长。证据 `docs/tmp/round43-owner-preflight.json`、`round43-owner-copy-recovery.json`。

## 本地部署与活动恢复

- Owner/store/service 定向回归 143/143 通过，含原生恢复及 HTTP 边界；另 HTTP/session 27/27、PowerShell 24 项通过。独立只读复审未发现维护接续或受信入口绕过。
- 新包 SHA256 `7c2e5be17f94a8e2821feb5c20d321b488d03dc67e356681b177c6699bd30385`，源码/包/安装 85 文件一致。旧 PID 6012 的维护许可经 revision 29 正式封存；新 runtime PID 30236、launcher 5140 保持维护就绪，历史账核对通过。
- 活动实例通过 GET 重新取得 CAS，再 POST 原生命令恢复两条任务。独立 `/state/tasks` 回读均 completed/succeeded，Owner idle/complete；水位分别 86/86、95/95。证据 `docs/tmp/round43-owner-live-preflight.json`、`round43-owner-live-reconciled.json`、`round43-task-completion-readback.json`。

## 远程重验期间的问题

UAT3 首次脚本将 preview 发到页面路径，未进入正确 API，返回非 JSON。原账保留失败，未发送 confirm。只读查明专属命名空间仅有 8 条夹具，无结果、无 Redis snapshot；在原归属及关联门禁下精确清理后，独立查零且注销会话确认 401。证据 `docs/tmp/round43-uat/backend-first-failed-cleanup.json`。修正路径后另起新命名空间重跑，不将首次失败算作通过。

路由诊断中，子进程异常把 APISIX admin API key 带入工具输出。已停止管理接口调查，不重复输出凭据；来源是 `apisix` 命名空间的同名 ConfigMap 内 admin 配置，需由凭据管理员轮换。没有把凭据值写入仓库或验收证据，不声称已轮换。

## 最终业务及恢复回读

- C57 PASS：13:42:42 UTC 正式恢复派发，维护 revision 30 inactive；13:43:54 延迟回读两条 Owner 仍 idle/complete，水位 86/86、95/95，事件总数 116 未增长。既有钉钉认证降级仍在，不能宣称入站恢复。
- C58 PASS：现有 UAT3 的 `3ea89c0d4daf970a5be9b8a7d40e7ec81f2da842`（PR #371，原 pipeline 277），两来源均 0.5 kg、声明 t、各权重 0.5，真实 preview/do-merge 后数据库持久结果为 1 t。证据 `docs/tmp/round43-uat/backend-business.json`。
- C59 PASS：现有 UAT2 的 `d1e447787201212140a2732b798d336965ddfaa7`（PR #368，原 pipeline 320），独立 Edge 添加自定义维度和意见，保存、离开、重进后逐字回显。浏览器存储已清空，浏览器及会话关闭，业务写入为零。证据 `docs/tmp/round43-uat/frontend-business.json`。
- 验收前后精确提交、Registry 镜像、Ready Pod 和 HTTP 身份一致；新后端及首次失败命名空间延迟独立回读四类资源均为零。审计记录按契约保留。证据 `docs/tmp/round43-uat/final-independent-cleanup.json`；原本地入口边界 35 项测试通过。
- 本轮没有重新构建部署 UAT 流水线、修改原开发分支、发送新的流水线通知。业务验收已完成，凭据轮换仍是未闭环事项（C60 FAIL），不生成全绿报告。
