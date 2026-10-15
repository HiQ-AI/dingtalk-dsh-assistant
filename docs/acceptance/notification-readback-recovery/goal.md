# 通知回读恢复

| 子目标 | 状态 | 证据 |
|---|---|---|
| Goal 失败对账、原任务恢复 | PASS | reply/check writes=0；正式 reply 后 operation=failed、previousObservation=unknown、同 task/session resumed |
| 九条正文匹配和不重发验证 | 进行中 | docs/spec/notification-readback-recovery.md |
| 本地部署与持久账本回读 | 待执行 | 等活动执行排空 |

原任务业务完成与运行时修复分开验证。现有对账入口保守保留 partialEffectsPossible，未将错误伪装成功或删除历史。
