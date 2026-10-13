# 第三轮

最终命令：

```powershell
node --test test/workflow-notification-obligations.test.js test/outbox-stale-blockers.test.js test/notification-retirement.test.js test/task-completion-notification.test.js test/task-requirement-notifications.test.js
```

实际结果：102/102 PASS，0 FAIL、0 skipped。覆盖外发关闭/无 adapter、同需求版本的新报告、最新报告未应用、其他任务、带 ACK、unknown、delivered 和正式退休守卫。

RepairStoppedLaunch 先 Check 后执行：7 个任务、47 个旧节点、27 个旧运行的历史一致性通过。新包 126 文件核验通过，SHA256 为 83399d6e1e9fd7e452aa91970af0e9e23a103c6f88a0cb914176bb4987fb80f8。新进程 PID 25896，认证 Web 200、控制面健康、收信正常。源码三份冻结字节文件 HEAD/index 规范化比较一致，只有换行变化；六个相关路径的 Git 过滤前后 blob 哈希一致。

关闭外发时先独立只读控制库：三条旧求助 superseded/leaseEpoch=0，记录各自替代报告；指定查询回复仍 prepared。恢复外发由用户明确授权。

重启 Check 在非维护状态因协调会话持续运行，60 秒内未排空，未停机。进入正式维护后 busy 全零。YAML AST 布尔值零写检查通过，精确 SHA CAS 将 writesAuthorized 从 false 改为 true；原生热重载期间双端口暂不可用，额外部署预检拒绝。随后同一进程双端口、health.outboundAuthorized=true、零恢复问题；维护 CAS 解除，未执行这次额外包安装。

10 月 13 日 10:53:22（Asia/Shanghai），插件发送状态查询及消息详情回读确认指定回复 delivered，消息 ID msgvlURG0nZ4uBFwoiRpPGiKQ==，leaseEpoch=1。三条旧求助仍 superseded/leaseEpoch=0。最终独立状态断言见 live-readback.json。

额外手工 `dws chat +messages-mget` 复查失败：同 profile 的 `dws auth status` 返回 authenticated=false、reason=token_refresh_failed、旧登录态临时授权码失效。未重新登录、未重复发送；此独立 CLI 层没有通过。插件先前实际发送与消息详情回读已经通过，不能把额外 CLI 失败表述为未投递，也不声称该 CLI 登录态已修复。
