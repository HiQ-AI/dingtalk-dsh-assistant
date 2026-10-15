## 问题与结果

显式后台服务曾等待进程退出才返回，原生job读取和MCP失败响应又被留在unknown，阻止原执行继续。Web补充已有任务还会另建话题，现场两个事项变成六个话题；归并时较早来源又可能排在更新指令之后。

本PR延续原后台修复，覆盖同execution的服务生命周期与原生读取身份、操作人精确结算已结束失败、Web续办复用和旧重复话题收口。任务、会话、原operation及已应用意图身份全部保留。现场当前话题已经收口为两个，四个旧话题保留可审计版本。

## 实现

- `dynamic-native-job.js`、`dynamic-process-scope.js`、`execution-session.js`：显式后台返回原job running收据，进程留给后续工具使用，execution排空时记录真实终态；前台提升继续等待终态，前台排空异常也不跳过后台清理。固定原生job读取身份，拒绝同名写替换。
- `dynamic-operation-readback.js:42`、`task-session-service.js:955`、`dynamic-task-store.js:391`：精确原生isError、参数/结果摘要、正常turn结束、排空和绑定只读调查仅构成失败证据，不能推断无效果。操作人必须通过受信本机Web原申请明确指定operation及摘要；全部结算和答复单事务，任一漂移整批回滚。普通模型reconcile不能自动清未知写账。
- `store.js:736`、`topic-model.js:32`：旧Web重复话题仅依据原task/applied/action引用关系识别，不按标题猜测。Check后单group事务添加目标归属、来源remove新版本与mergedInto收据，直接processed；旧消息/决策/操作/任务及历史版本不变，不重做旧意图。
- `task-session-service.js:926`、`store.js:775`：隐式续办沿原task的话题映射到当前revision并去重，显式版本仍严格校验；补充/重开/取消复用首个话题。活跃决策不允许覆盖，单任务blocked保留项取消仍可用，共享决策含其他任务时拒绝。
- `topic-model.js:70`：先按指定revision计算归属，再按来源sequence稳定排序；历史版本的成员不变，同一消息多个单元维持相对顺序。

## 关键实现

`packages/dingtalk-dsh-assistant/dynamic-task-store.js:396`

```javascript
reduce('source.record', record(a.source), `${commandId}:source`)
for (const resolution of resolutions) reduce('operation.resolve-investigated-failure', {
  ...a, ...resolution, operatorSourceId: a.source.sourceId, humanRequestId: a.requestId,
}, `${commandId}:${resolution.operationId}`)
const result = reduce('task.human.respond', { ...a, sourceId: a.source.sourceId }, `${commandId}:reply`)
```

以上步骤归同一个command外层持久事务；第二项失败也会回滚第一项释放和wake。Store另行核验配置webActorId、任务/申请版本及排空状态。

`packages/dingtalk-dsh-assistant/store.js:775`

```javascript
const reuseTopics = !!taskSessionReader && topicRefs.length > 0
const topicId = reuseTopics ? topicRefs[0].topicId : stableId('topic', `web:${identity}`)
```

同一任务的Web补充沿原话题新增来源和独立决策，不再用每个requestId生成一个新话题；无topicRefs的新任务仍可建立独立事项。

## 验证

- [x] 设置真实已安装DSH profile后，13个相关测试文件实跑322项通过，0失败、0跳过，见 `docs/acceptance/topic-routing-reuse/round-15-all-related.log`。
- [x] 最终话题/路由/原生回归160项通过，包含归并后来源时间线、旧版本成员、多个单元拆分、唯一effectOwner、幂等/版本漂移、取消及多任务阻塞反例，见 `round-19-chronology.log`。
- [x] 原生HTTP用例验证Check零写、外站拒绝、摘要漂移、重复答复与正文冲突、第二项失败整批回滚、原execution/session续办且错误工具只调用一次。
- [x] 两次指定DATABASE_NOT_FOUND原operation正式failed/partialEffectsPossible，完整previousObservation及精确日志序号保留，未标成功或noEffect；原Web技术申请answered，原execution/session续办到输入8，Bytebase重放数0，见 `round-9/resolution-readback.json` 和 `continuation-final.json`。
- [x] 四个旧Web话题已按Check摘要归并；默认话题2、含档案6、当前归属唯一，旧revision1仍可读；原task/execution/operation状态及版本独立比较完全不变，见 `round-18/final-readback.json`。浏览器确认两话题及原关联任务。
- [x] 最终Assistant SHA256 `7ed96f75702cd75fce18d2df4e0e51d016f4429c3bd5b2bfb93b18df09939c89`、Observer `67e1438d448db76936a233ce0d2ac7930d2c13d6fccedd2c3a02f0b8ef79136d` 已部署本地；源码/包/安装内容独立比对，新PID55216同时持有Web与控制端口，profile摘要保持，inbound/DWS就绪。`round-20/final-readback.json` 证明撤回话题sequence为9,12,13,14，另一话题8条来源有序，默认2/档案6且原业务账未改；真实Chrome已点击核验。健康仍degraded：两条历史通知未确认及一条业务交付批准等待，不声称全健康。
- [ ] 本PR不证明业务UAT部署、真实页面业务E2E、此前共享测试副作用无影响，或历史两条通知已经送达；这些仍是独立边界。

## 风险与回退

原生失败结算保留partialEffectsPossible和操作人原文，不能据此自动重放或扩大业务批准。归并新增Topic元数据，SQLite表结构不变；只能回退到能保留mergedInto/mergeReceipt字段的受控包，不能让更早二进制重写已归并domain。排序修订可回退到本轮90a21792包，历史数据无需重建。完整部署和分轮记录位于 `docs/acceptance/topic-routing-reuse/`；历史失败轮次和被审查拒绝的初版路径也保留，不冒充全程一次通过。
