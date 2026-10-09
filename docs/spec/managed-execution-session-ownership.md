# 受管工程执行会话的原生归属

## 问题与证据

普通原生会话的history follow会由API Session Controller异步恢复Agent。工作流工程节点虽有插件身份事件，旧header未声明受管子会话，故观察可占用原ID。两个现场节点已领取新lease但原生日志没有对应输入；真实日志副本在隔离原生SDK可正常恢复。观察激活是已确认能力，尚不把所有现场错误归因于该唯一调用。

## 最小路径

新工程执行创建时使用公开meta.origin=subagent。历史header不可原地修改：Session.header只读，Persistence无元数据更新API，因此必须公开seed派生，保留parentSession和完整历史。

复用group-coordinator原生idle runMaintenance锁：确认旧会话身份与Task/node/input一致、idle且无inbox，尾部仅允许完成回合与end-seed、无用户额外输入。活跃和不明归属拒绝。创建确定性子ID，origin=subagent、parentSession旧ID；以完整历史seed及显式插件换绑事件建立可审计身份链。CAS期间保持原会话idle锁，变化即拒绝；不操作外部Agent的私有注册表或dispose。

新增仅节点会话换绑命令，检查run/node/lease/input/session状态、任务来源屏障/控制版本、当前计划、零节点效果/输出。保持Task/Run/node/generation及成功前缀。ready节点在领取前换绑；当前running但尚未steer新lease的孤立节点仅在无本控制器flight及持久证明原native最后lease低于当前lease时转ready并标记排空。waiting的业务错误不由此恢复，尤其中断仍走Owner一次resume。

控制器复用执行适配器prepare步骤，不新增通用恢复系统或审批入口。已派生会话恢复继续校验原身份+显式parent链。新会话被普通Web自动恢复拒绝，观察API保持可用。

## 验证

原生测试覆盖真实idle观察、冷旧会话、活跃/额外输入/身份漂移拒绝、子会话原生origin和完整seed。worker/controller测试覆盖CAS、节点效果、未steer running恢复、Task/Run/成功前缀不变及中断恢复门禁。仅隔离测试，不写live。

## 维护准备接口

内部 `controller.prepareManagedSession(runId, { maintenance: { maintenanceId, revision } })` 仅准备唯一旧 agent 节点，返回 `{ prepared, state }`，不 schedule、不 claim、不调用模型。Controller 必须按原受信 workflow 模块构造（函数、摘要、工具白名单保持原合同），不能将持久 JSON 填空函数来冒充定义。

维护期间节点换绑命令必须携带精确维护 id/revision；非维护时禁止携带该对象。换绑仍校验原来源、Task 控制状态和 node/lease/run revision，并保留 `node.claim` 的维护拒绝。运维须先通过正式 Loader 卸载 Resident、取得控制库独占，再准备和关闭自身 worker/child handle；外部 idle 观察句柄不 dispose。完成后正常恢复 Resident/部署，不能以此把活跃节点标作排空。

CAS 回执未知或拒绝后，确定性子 ID 可复用：必须匹配 parent/origin/cwd、完整继承历史及唯一换绑事件，且没有任何新增业务输入。子会话恢复再次校验原生 header 的 parent/origin 与插件身份链。

## Review 后收窄：仅一次维护迁移

原生 runMaintenance 不锁住输入：send 仍会先 inbox.splice，结束维护后唤醒。因此删除 drive/recover 自动旧会话派生，禁止借用任何已有观察 Agent。仅正式维护内部 prepare 接口可用，必须先正式卸载 Resident 与 API Session Controller，验证两者 Loader entry disabled 且 fiber 已释放，并确认目标 agents/sessions 均不在注册表。维护桥自己 resume 冷旧会话并持有 handle，prepare 后 dispose；恢复 API 后新 child 的 subagent 归属永久防止普通观察接管。前文“保留旧观察句柄”的初始设计被本段替代，不将原生 idle 锁误称输入锁。
