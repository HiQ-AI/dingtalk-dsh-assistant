# 第二轮：本机切换

2026-09-20。用户要求本机切换后，`/state/tasks` 回读 56 个 Task 均为 completed，包含原来运行中的编辑器权限拆分与曹勇工时任务。旧 DSH Web PID 954124 独占 3080/18998；停机后两端口不再监听。

稳定存储备份位于仓库外 `D:/dsh_backups/leaf-owned-15b5b50`，原文件与备份 SHA256 均为 `3E28E55EAC79F2913219923F12C36D600EA70401529C277F86AADD177B2030AA`。停机后 `node scripts/check-resident-storage.mjs --check` 返回 Domain v8、56 Task、无无效记录、`strippedFields=0`。

Assistant 包在 `docs/tmp/leaf-owned-15b5b50/` 打包，SHA256 为 `172423C5C60E0BDF4115BB4016E03EC5739AB9541837A1902B57D84B62DE8553`。原生 profile CLI 安装后回读 profile 依赖指向该包；Observer 仍为 `0.5.15`，profile patch SHA256 保持 `0F1EFF8712FC4CC2202CD8A1E6452E7BED7A913D0388520A3575337CE97733D0`。安装目录的 `runtime.js`、`task-result.js`、`topic-runtime.js`、`store.js` SHA256 分别与合并源码一致。

计划任务 `DSH Web Local` 启动后，新 PID 570992 持有 3080/18998；延迟复查进程仍在运行。`/health` 为 ok、恢复告警 0；`/state/dws-bridge` healthy，群 listener ready、backfill ok、人工回复监听 ready；`/state/agent-config` HTTP 200；Web 未认证访问返回 401。`/state/tasks` 仍有 56 个 completed，无 running/waiting，三项关键 Task 保持 completed。Web 登录后的可视页面和真实群消息投递未在本轮独立验证。

版本接口仍显示 `0.5.15`：此次是同版本号的本机修复包安装，是否生效以安装源码哈希、进程重启及运行态回读为依据，不以版本号单独判断。
