# 已审计重启操作的告警显示

Host 重启后缺失原作业终态的操作仍保留 `state: unknown`。完成有效的 `host-restart-isolated` 隔离审计，不会补造原退出码、工具结果或成功状态。

活跃告警使用恢复流程既有的 `hasRestartIsolation` 判定：已满足完整绑定、摘要、来源排空及人工确认合同的操作，不再计入活跃恢复故障。操作详情、原 unknown、可能部分副作用和禁止重放的审计记录保持原样。缺失或失效证据的 unknown 继续告警；其他任务故障和通知 unknown 不受影响。

任务服务的告警列表同时供 `/state/recovery-issues` 和 `/health` 使用，因此无需独立清除健康计数，也不需要修改数据库。现有告警接口仅供读取，没有按 ID 确认告警的写接口。

定向验证：

```powershell
node --test test/observer-audited-restart-alerts.test.js test/native-restart-isolation.test.js
```

本改动需按正常插件发布安装后才影响运行实例；本地测试或离线投影不表示现场告警已经清除。
