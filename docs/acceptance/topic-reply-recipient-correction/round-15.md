# Round 15 — Native 通知恢复只读与不重发代表路径

日期：2026-10-29（Asia/Shanghai）

## 结果

原始 PowerShell 命令：

```powershell
$env:DSH_NATIVE_TEST_PROFILE='D:/dsh_home/profiles/web/package.json'; node --test --test-name-pattern='notification service manual unknown recovery is readback-only|manual notification recovery of starting and legacy guard-unknown remains readback-only|deferred service confirmation persists ACK, recovers after restart and never resends|native service reopens an unknown notification for readback without resending' "D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-reply-recipient-correction/test/task-session-http-integration.test.js" "D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-reply-recipient-correction/test/task-notification-delivery.test.js" "D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-reply-recipient-correction/test/task-session-service-native.test.js"
```

- 共 4 个主 case（含 starting/unknown 两个子 case），6 pass、0 fail、0 cancel、0 skip，13724.6618 ms，exit 0。
- 覆盖 starting/unknown 手动恢复只读回读、不重发；deferred ACK 重启后不重发；native unknown 通知回读且不重放业务。

## 边界

这些是既有代表路径，不覆盖所有冲突组合，也不证明真实钉钉送达。使用指定 native profile 与受控测试服务；未创建最终 `report.md`。
