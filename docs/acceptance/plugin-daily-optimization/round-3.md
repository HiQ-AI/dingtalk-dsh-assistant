# 第三轮：历史 Session 缺源的部署验收续修

2026-09-21，本机初次安装 PR #111 合并提交 `25a3429` 对应的 Assistant 包。安装前只读确认 61 个 Task 全部 completed；停止已核实的 DSH Web 及其两个 DWS 子进程，备份稳定 v8 存储并核对 SHA256。新包源码与安装目录关键文件哈希一致，新 PID 同时监听 3080/18998，DWS bridge healthy。

启动后 `/state/recovery-issues` 出现多个 `activity-projection`，错误为已完成 Task 的持久 Session `not found`。这是旧 Session 已不存在，原审计把不可恢复的历史缺源当成可重试的当前写盘故障；重复巡检会持续使 health degraded。没有活动 Task 被中断，也未重放群消息。

续修将 `prepare` 的明确 `session not found` 分支移出重试队列，在 `/state/activity-audit` 保留 taskId 与 `session-not-found` 原因；其它读取或投影写入失败继续重试并保持健康告警。新增缺源只尝试一次、不制造当前故障的回归，以及 HTTP 健康汇总断言。旧活动来源不可恢复，不能据此补造活动或宣称历史完整。
