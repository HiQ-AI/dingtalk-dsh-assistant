# 任务会话直查闭环

## 最终回归

完整服务的 300 个唯一用例全部通过。根据上一完整轮次的真实用例名称，按轮转拆成三个不相交集合；每组正则只匹配其 100 个完整名称。最终输出逐项核对并集为原 300 项、没有遗漏或重复；三组均 100 PASS、0 FAIL、0 cancelled、0 skipped。耗时分别为 184445、267299、244448 毫秒，运行源码相同，临时产物在较短的仓库 docs/tmp。私有名单和日志为 `docs/tmp/direct-service-full-partitions-r32.json`、`docs/tmp/direct-service-full-r32-group-0.log` 至 `group-2.log`。单进程复现入口仍是 `node --test test/workflow-service.test.js`。

本轮修正上一轮失败的测试前提：Owner 模型与消息接纳异步；模型失败读原生 Owner.lastFailure；单次效果对账测试调用原恢复扫描而不是循环等待 helper；原发送人验证使用真实受管前序和合法源条件；零 Run 取消任务先完成并独立回读最终通知，再检查删除。没有放宽审批、未知效果、材料来源或完成校验。

其他相关回归：核心 12 文件 312/312、最终恢复/最终合同三个文件 47/47、HTTP及入口三个文件 37/37、真实工程工作区 13/13、工程/领域衔接 6/6、Owner 工程同 Run 修复两项 2/2。数目按各次实跑分别报告，存在重叠，不相加冒充独立用例数。

## 行为验证

- 直接读取消息、状态等已登记工具后，真实 Task 在零阶段和零 Run 下通过一次最终验收；只有最终群通知可以被领取，隔离渠道回读证明仅一次。
- SQL、文件、工程和 UAT 继续走受管操作。查询成功不能代替执行、批准或验收。伪造引用、兄弟任务、旧需求、授权及输入版本变化均拒绝。
- 工程 v18 直接使用当前 Task 查询事实，无独立调查交接；真实工程准备、方案、证据回读和冻结定义恢复已覆盖。
- 慢 Owner 与渠道回读挂起时，新任务接纳、取消及另一任务既有文件阶段观察/最终接纳继续。未来退避和输入屏障不会忙循环，解除后原会话继续。
- 暂停、取消、重执行、报告重写、归档和删除均使用真实当前状态；保留原审批、效果、防重账和历史证明。当前版本变化不能复用旧验收。

## 正式部署

最终包 `zzusp-dingtalk-dsh-assistant-1.0.0-direct-owner-final-20261003-r31.tgz`，SHA256 `36917af45d8a7a9c33a6452c9bbd4955e1c9b3c5e3a0321060750a674774ad4a`。部署参数和证据存私有 `docs/tmp/direct-owner-r31-deploy-args.json`、`docs/tmp/direct-owner-r31-deployment/`。Check 的 writes=0、tasks=0、historicalBackupRequired=false。沿现有维护、排空、封存、精确包安装、Readback、Resume，不恢复旧任务或迁移 schema。

正式安装、独立 Readback 与 Resume 已完成。新 PID40368 同时监听 18998/3080，旧 PID52928 已退出；health=ok、维护解除 revision414、dispatchResumed=true、自启 Settings.Enabled=true。当前目录9个工作流且无 task-investigation，Task=0，安装版本1.0.0，配置应用changed=false。原生健康与维护/目录/Tasks API分别回读，证据为私有 direct-owner-r32-independent-runtime.json、direct-owner-r32-readback.log、direct-owner-r32-resume.log。普通部署backupCreated=false；未恢复清理业务记录。

## 验证边界

隔离测试的模型和通知为测试适配器；真实文件、Git、HTTP、SQLite、工件和原生事务已经实跑。本轮未创建生产工单、执行生产 SQL、代真人审批或向真实群发送测试消息。此前删除列业务闭环保留旧轮次，不能代替本轮验证。

部署首次停在停机前检查：自启任务 Settings.Enabled=false，但其 State 仍是 Running。旧 PID52928 仍存活且尚未安装；维护已封存 revision413。沿根因修正原生 Enabled 回读、禁用前保存恢复意图及同进程原封存许可接续，不绕过维护。两个 PowerShell 测试文件全绿（24组、6组），包含身份/版本漂移拒绝。恢复既有自启配置后，新的接续 Check 为 writes=0/tasks=0，继续同 maintenanceId 和 revision413，证据改存 `docs/tmp/direct-owner-r32-deployment/`。

