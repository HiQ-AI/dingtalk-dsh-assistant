# Round 80：Owner 观察不被执行恢复占用

## 事实与范围
SG19 原 Run 的 verify lease 3 于 2026-10-09T04:38:48Z 失败（execution events 43391/43392），Owner 最后失败仍为 event 429（04:13:49，04:15:49 处理）。只读证据：docs/tmp/sg19-failure-owner-delivery-gap.json。失败指纹本来已包含节点 lease、诊断和当前执行快照；本轮没有修改去重键。旧 flight 的精确 await 停点未收敛。

## 修改
- workflow-service：Owner observe/dispatch 独立 single flight；计划推进、web 输入、效果对账仍在原执行恢复链。消息 reconcile 置于消息恢复 flight。
- resident：启动恢复异步记录结果，原 5 秒 timer 不受其阻塞。
- health 增加 recovery owners/tasks 的 phase/taskId/since；不进入事件摘要。
- 关闭拒绝新恢复，等待已有 flight 后关闭 execution store。

## 实跑
PowerShell 中 TEMP/TMP 指向 docs/tmp/authorization-state-tests。

`node --test --test-name-pattern='执行恢复被 Web 输入阻塞|关闭等待既有恢复|任务直接调查慢回合|Service 自动对账|交付只读恢复' test/workflow-service.test.js`

16/16 PASS，日志 docs/tmp/round80-service-final.log。真实 worker、code node 失败及原 Owner 事件：web 输入 query 尚未 resolve 时 failure 已入原 Owner；再次恢复相同失败仅一条事件。关闭等待旧 flight，之后不启动新恢复。原 unknown 效果不重发；maintenance/pause/stop/input 门禁保留。

`node --test test/dingtalk-dsh-assistant.test.js`

8/8 PASS，日志 docs/tmp/round80-resident.log。包含真实 Resident apply/dispose 基础挂载及既有启动约束；该基础挂载未配置工程 workflow，不冒称已经复现全部现场启动。

## 未验证边界
此轮尚未部署，不宣称现场 SG19 故障已投递。部署后须独立读新 Owner workflow.failed 事件及会话处理，检查 health recovery 定位；不取消进行中的业务检查。

### 部署 Check 旧事故恢复适用性纠正
统一入口曾在普通 DEPLOY_NOT_DRAINED 后无条件调用旧 SG20 事故 registry.restore，导致后续副本报 ENGINEERING_REVISION_BASE_MISSING。现先只读核固定事故 nodeRunId、gen6/lease1、waiting/controller-restarted/undrained，且仅该1节点忙、无 busy Owner/effects/messages；不适用直接保留原 DEPLOY_NOT_DRAINED，等待正常工作自然排空，不进入旧事故桥。

独立现场读回：SG20 verify-candidate 已 succeeded/drained=1/lease2，prepare-local-acceptance waiting/drained=1/lease1。新 preview 返回 eligibleRecovery=false、writes=0、DRAIN_INCIDENT_NOT_CURRENT，维护revision523，profile SHA3b5c不变；未创建manifest、未暂停或取消会话。

脚本验证：`node --test test/recover-verification-drain.test.js test/deploy-local.test.js` 首跑30例中29 PASS；新fixture全角中文throw经子进程编码使reason无法精确匹配，未改变生产逻辑。隔离fixture改ASCII DEPLOY_NOT_DRAINED后，`node --test --test-name-pattern='普通活跃节点|旧事故适用性' test/deploy-local.test.js test/recover-verification-drain.test.js` 2/2 PASS（docs/tmp/round80-deploy-drain-final.log）。原29例包含既有事故完整桥、profile字节不变、正常部署及失败不续行；新例证明正常busy保留原错误、零写、不运行bridge。
