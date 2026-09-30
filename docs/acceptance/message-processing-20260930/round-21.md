# 第 21 轮：重试排队时钟闭环

## 修复与验证

- 执行窗口绑定每次真实模型lease，排队不沿用上一轮deadline；Host单次调用超时、落账预留及租约核验保留。
- 恢复次数根据原生失败事件及当前失败节点的lease去重计算；包含排队的墙钟年龄和旧扫描次数不作为失败次数。
- 领取前超时经正常recover清理同原因事项阻挡，其他阻挡不变。无需重新投递消息或清理运行库。
- 三组相关测试151/151通过，包含旧recoveryWindows=2但仅一次真实失败的同版本恢复、S不重跑、重复扫描不扣次数、三次真实失败耗尽、单次超时与旧lease拒绝。
- 新包99文件与源码一致，摘要见round-21-packages.json。扩大集成与正式部署结果继续独立回读。

## 边界

真实重放保留原版本、任务与通知回执；此轮不批准或执行生产SQL。原始模型输出、群消息和备份记录仅留本机docs/tmp/message-processing-deploy/。

- 扩大集成：node --test --test-concurrency=2 test/message-ledger.test.js test/message-impact.test.js test/workflow-service.test.js test/http.test.js test/workflow-notification-obligations.test.js；290/290 PASS，0 fail、0 skipped，158488ms。零写部署预检通过。

## 正式部署

- 新PID17264，助手99文件与看板4文件均匹配精确包；健康ok、recoveryIssueCount=0，认证Web303/200。旧22 Task、76历史节点、29终态Run及68旧任务摘要全部一致。
- Resume后maintenance revision165、active=false，定时启动恢复。
- #114保持来源版本4，从needs_attention正常恢复pending并领取新R节点，旧S成功记录保留；未调用reprocess。其余来源版本不变。

## 真实历史配置反证

#114保持版本4恢复后，R两次调用分别因MESSAGE_DEADLINE_EXCEEDED被拒。只读节点证据显示本次lease只获得20.5秒，而当前Host实际允许60秒；旧run.policy.attemptMs=20000，现有currentWindowPolicy只更新initial/linked窗口，因而lease错误读取旧策略。两次真实失败事件仍保留，A14本轮FAIL。已维护revision166排空，继续将本次调用窗口显式传入领取事务，并补旧policy与当前Host不一致回归。
