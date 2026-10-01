# 只读调查 Owner 受管再评估

已停止的只读调查可能留下材料权限不足的失败结论。新增本机再评估入口，不新建Task、不改requirement、不覆盖旧失败，也不声称外部连接已恢复。Host从当前requirement和当前来源重新生成可读材料范围与旧scope差异事实，写入不可变恢复payload；Owner正常读取当前证据后决定是否重评计划。

POST /tasks/:id/reassess-readonly 只接收 recoveryKey/reason 和 ownerRevision、leaseEpoch、requirementRevision、controlRevision CAS。仅本地Web身份且taskAccess授权，task控制active、Owner idle/blocked无在途决定、只读调查已失败/blocked、全部节点drained、无pending input及effects、无外部阶段时通过。事务复查身份版本和状态后复用task.owner.event记录固定system.recovery，不修改需求或伪装用户补充。

恢复payload由Host生成，调用者不能填资源/正文/权限；包含requestDigest及来源版本/正文摘要供事务复查。同key同参数回读，异参拒绝。原Task/session/失败证据保持；后续Owner不能把“材料可读范围已修复”当调查成功、用户确认或生产批准。

验证本机严格参数、CAS漂移、在途/未排空/外部效果拒绝、事件幂等及原需求会话审计保留。禁止真实变更、部署和备份。

## 已接纳但明确未执行的非法修复动作

再评估允许处理唯一已知的 `repairCurrentStage` 接纳后应用失败：Owner 当前 blocked、最后失败恰为 WORKFLOW_REPAIR_NOT_ADMITTED、当前租约对应动作 application_status=blocked。保持四项CAS，并先证明全部只读调查排空、无effect、无pending/running动作。事务调用原生 task.owner.discard 封存该动作，然后写 system.recovery；保留原decision/失败计数/报告审计。未知失败、其它动作、pending或在途动作一律拒绝。此路径不重新应用非法修复，不重设业务需求。
