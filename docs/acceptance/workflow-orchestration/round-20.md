# 第20轮：同稿检查点重启恢复

## 修复与回归

生产权限核查Task原报告已收到协调reject，但input-wait后重启时存储schema重排字段，JSON字符串比较误判另一待审稿。使用原生结构相等，按原报告形状恢复待审对象并保留checkpointId/submittedAt，复用既有审阅ID；不修改全局指纹算法。

- `node --test`：630/630 PASS，0 fail/cancel/skip，58.37秒；输出round-20/full-tests.txt。
- 真实字段顺序变化、input-wait重启、已持久reject组合反例通过：报告接收一次、审阅一次、原ID不变、拒绝仍拒绝；真实不同稿继续failed且不覆盖旧checkpoint。
## 本地部署与现场回读

- 已按用户“允许中断并重启，核验任务恢复”授权执行check后切换。稳定存储预检0 invalid/stripped/unknown；完整当前存储/profile备份：`D:/dsh_home/backups/decision-context-e48f61e-20260922`，备份摘要独立比对一致。
- 源码e48f61e，包SHA256 `A2451F98B081C4FBB1EAF0DA8ED6104A289381D9EC68316620ABC1C178659045`。唯一tgz路径安装，34个JS独立hash全相同；其它依赖、settings和patch不变。
- 新PID179220，2026-09-22 18:13:33启动，3080/18998同PID；Web认证握手303、页面200 HTML；入站与DWS桥接正常。18:16仍存活。
- 权限核查原report通过无body retry接口返回202后独立GET：reviewStatus=rejected、nextAction=revise-report。原checkpoint身份及reject保留，Task running且原Session出现新assistant事件；没有把审阅接纳误当批准。
- #1336和#1353同原Session继续产生事件；#1354当前completed。以上为Runtime/Session恢复事实，不代替业务验收。
- 翻译旧错误通知决策rejected，旧Outbox为0；新决策completed、操作applied、topic revision/processedRevision均5，原Task重开inputVersion2/run2。
- 三条旧重开Task的原Session不存在：翻译、同名关联ID合并提醒、数据集合并单位不一致；均queued，health degraded且3条task-start session not found。未创建空Session绕过，历史恢复仍未闭环。
- 脱敏回读：runtime-readback.json、task-session-readback.json、translation-readback.json；不含凭据、原始消息正文或完整业务报告。
