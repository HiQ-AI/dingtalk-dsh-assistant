# 原文澄清关联与任务发起验证

## 测试

- node --test test/message-ledger.test.js：123/123 PASS，61221.754 ms。
- node --test test/message-workflow.test.js test/message-coordinator.test.js：58/58 PASS，23349.6139 ms。
- node --test test/http.test.js：37/37 PASS（本机/Origin、dryRun/apply、身份及答案注入拒绝）。
- node --test --test-name-pattern='历史澄清恢复服务' test/workflow-service.test.js：1/1 PASS，901.3128 ms。临时隔离库构造旧unknown快照，其余预检、apply、维护退出、创建Task都使用真实service/store。连续两次process仅1 Task，原请求resolved且双来源版本不变。
- 集成测试发现dryRun不带expectedDigest时摘要包含undefined，已修复为仅执行时计算摘要，再实跑通过。

## 存储恢复

首次部署Check因现有PID129740的STORE_UNAVAILABLE失败，尚未部署。只读quick_check=ok，maintenance busy四项均0。复用原生witness/disable/enable CAS：完整disposed见证同PID/nonce，18998关闭而3080保留，owner独占锁获得且snapshot drained=true。TTY结束锁输入曾报DEPLOY_LOCK_COMMAND_INVALID，finally释放锁，结束的仅本次锁工具；未执行迁移或强停Host。

精确移除追加块后profile恢复原SHA e026ce9c9f7447968a6a2c8c7b13486d96134031e1b6d07f6f96e877e6f87e6f。同PID129740重载完成，维护接口inactive/revision459，health ok/inboundProcessing true。存储worker不可用的底层触发原因未确认，不把重载成功写成根因已修复。

## 产物

Assistant SHA256 bbf1f7180c4cc8f07f9df8eb6c868f716424bd320809610cce31ca5b05608afa，包源码独立核验100文件。后续正式部署、Check/Apply和真实Task证据另列。

正式部署前第二次Check通过；首次执行因D盘可用930512896 bytes低于门槛1081214444 bytes而零写拒绝。独立检查余量自行回升约2GB后，以同精确参数再次执行，未删除用户文件或停止其他服务。源码提交e489ec3，当前新包已安装，维护保留，等待独立就绪回读。

## 现场恢复与唯一任务

新实例PID119412，Assistant包SHA与上文一致、100文件核验；正式HoldMaintenance部署ready，旧Task/30节点/1Run历史验证保持，认证Web通过。12:43对真实#124/#125执行dryRun，摘要99d1e1a166469a83f6a9ce1a155a9a1b222bb24017f486ce8f652888616ec33c。核对原问题“评审规则、排查现有实现，还是按文档开发？”及同作者真实后续“按文档开发”后执行CAS。

独立回读：#124 run settled、request resolved、answer=按文档开发、resolvedByActorId=原李辰账号；原sourceVersion仍1，#125版本仍2；旧create恢复pending且taskId保持。随后以原部署参数Resume，维护inactive。

12:44:31实际创建 task-1edb9931ffe6ecd4efc0a3949376d66f，标题“开发数据集过程导入导出功能”，Owner session owner-c0bd2371e0dc44d942eb6ceddd6d2b79b6634807。12:45再次读回该taskId数量1，原create command applied，#124 pendingRequests=0；原生产Editor任务仍completed。初始Task/Owner均running，Owner一轮接手后转waiting，原因记录为未指定UAT环境与文档正文可读取性；本轮目标为任务发起，不将其写成业务开发完成。

health ok、inboundProcessing true、maintenance inactive。真实任务创建已通过；第三条通知保留，未伪造答复、重放来源或新建第二Task。检查输出中一次PowerShell数组包裹导致taskCount误为0，随后改为直接枚举REST数组并明确断言唯一Task，再独立保存最终证据。
