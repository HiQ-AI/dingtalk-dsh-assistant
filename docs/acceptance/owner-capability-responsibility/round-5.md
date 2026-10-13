# Round 5：执行会话完全权限

用户明确要求完全权限，而不是工作区内修改。

- 源码：Owner 每次创建/恢复在模型请求前，调用原生 permissionPresets 设置 danger-full-access，并检查映射 sandbox=danger-full-access、approval=never 和 current 回读；暂停成果评估不提升。
- `node --test test/task-owner-session-native.test.js`：65/65 PASS。覆盖恢复时旧 workspace-write 被覆盖、缺服务不调用模型及暂停评估边界。
- 现场：正式 commands/execute 调用原 Owner 的 `/permission danger-full-access`，随后独立 `/permission` 回读为 current preset danger-full-access。
- 原生日志独立证据：seq 8564 permission/preset=danger-full-access；8565 sandbox/mode=danger-full-access；8566 approval/policy=never。时间戳 1791873666783–1791873666789（以原事件为准）；原会话 owner-96bb0841f86f9e522c674761a431b438e7bb01fd、原 turn-7cb214a2-f336-4af3-8cc0-c68a1f444210 仍 running，revision=16、lease=6。没有取消或代做业务。
- 新包部署 Check 拒绝 DEPLOY_NOT_DRAINED，未安装或重启；当前运行中原会话权限已通过原生接口实时生效。后续新建/恢复自动设置的源码尚待部署。
- 不声称原 UAT 业务核验或群回复已经完成。
