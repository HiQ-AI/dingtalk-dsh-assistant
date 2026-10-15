# Host明确失败结算验证

- round-8-tests.log：163项通过，0失败、0跳过。
- 覆盖精确原生错误/参数及结果摘要/正常回合结束/排空/调查绑定，正文错误不证明无效果。
- 操作人必须在本机Web回复显式给出operationId与摘要；模型自动reconcile不获得通用失败结算能力。
- 受信webActorId、任务及申请生命周期、第二项失败整批回滚（source/operation/resource/wake）、Check零写、摘要漂移与外站拒绝、重复幂等和正文冲突均有测试。
- 真实原生fixture从错误到绑定调查、人工答复、原execution/session续办，错误工具实际执行一次。
- 独立审查最后无部署阻断；Check是预检快照，正式事务仍重新验证完整生命周期。
