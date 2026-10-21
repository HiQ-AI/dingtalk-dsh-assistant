# v1.3 第二轮实施交接

2026-10-21；基于 main 94f99720836e134f0615dc7e02f0f4d4bd72b7e9，分支 feat/coordination-v1.3。
本轮承接 63849ec。云环境断开提示后已在原 /workspace/dingtalk-dsh-assistant 成功继续执行，未切换环境。
用户要求在安全检查点交接，因此本轮结束不表示首版四阶段完成。不得部署。

## 已接通的闭环

1. 消息前置路由的 unit 可以声明 dispatchOwner=coordination，Topic refs 可为空。
   route 与 resident source reservation 同事务落账，保留权威原文/附件引用及 generation。
   reserved/needs_clarification 排除旧 Topic 接纳、应用、恢复、承接 outbox 和旧发送候选。
   混合消息的讨论 unit 独立处理，Topic 完成不结清协调待澄清事项。
2. TaskSessionService 实际消息入口调用独立协调服务。语义会话只开放有界同群查询与提案提交；
   显式独立 provider/model 配置，未配置则拒绝启用，不继承或改变 Owner/execution 模型。
   原话可分页读取，任务目录截断显式可见，指定任务须读取详情及当前版本。
3. Host 冻结规范 task.coordination.input envelope，按运行补充、继续、reopen、明确取消分别调用原 Task 服务。
   preserve/replan 先校验；暂停继续在同事务恢复控制并应用补充；版本与完整摘要重放校验。
   applied 后的 materialize/feedback/wake 交接有持久回执，崩溃后只补未确认交接。
4. execution/inputVersion 指令范围由 Host 绑定，ready 指令不能被空 IDs 绕过；
   已在途输入明确标为既存范围，新 continue/retry 重新绑定，claim 锁前校验。
   正式 complete、当前上下文/运行版本、指令覆盖、decision receipt 与独立全局事件同事务提交。
   恢复 dispatcher 以持久消费游标读取事件并回读当前 Task，旧成功不释放已变更版本。
5. 定时查询已从真实消息接纳、同事务建 schedule，到 recover 扫描、claim/read-only job、冻结通知、
   现有 resident outbox、统一 notification.start/send-permit 和 readback 的闭环。
   无 Topic、不造 Task、不唤醒被查询 Task。业务与投递分别记录。
6. schedule future-only 修改保留已接纳版本；显式 unstarted 替代维护 replacement 链和 slot 指针。
   暂停保留游标，恢复按迟到策略合并；同计划串行和积压上限；多年遗漏计数及 DST 政策固定。
   整单取消同事务作用于计划/实例，发送许可前后边界分别展示。
7. 过期且未许可的候选在动态事务内重新只读查询、增加 resultVersion、永久 supersede 旧候选。
   start 再核验当前候选、结果摘要和控制版本；已许可/unknown 不刷新换身份。
   service 已接发送前自动刷新；同 event 的唯一性有事务检查和 SQLite 唯一索引。
   freshnessWindow 默认 300000ms、grace 默认 900000ms，随计划和实例持久化。

## main 与原方案代码基线的差异

| 区间/变更 | 当前代码事实及本轮处理 |
|---|---|
| 99a429 → #232 / 9270321 | 新增当前 binding 的资源只读快照及 execution_resources_read；继续复用，不把锁释放当业务完成。 |
| #233 / #234 → 7ca36c | 精确 SHA 发行分组、固定三包/摘要产物及 v2.1.0；发布不等于百部部署，本轮不发布。 |
| #235 / fd5216b → main | 测试历史拆分已实际合并，采用最新 AGENTS 和逐注册映射；没有擅自合并旧未授权 PR。 |
| #236 / e53044e → 94f997 | Owner 正常结束但无提交走 TASK_SESSION_NO_SUBMISSION，保留原 wake/session/provider-recovery。本轮只在正式 task.complete 产生事件；补回归验证空返回不产事件、恢复完成恰一事件、不重放原生写。 |

原有 Owner 空返回退避/停止预算未改；未恢复已搁置的只读中断实验。
新增指令归属最初泄漏进 native inputHistory，风险回归暴露三项续办失败；
修复为 Host 内部保留证明、native binding 投影仍沿原四字段合同，定向复验结果见测试日志。

## 验证范围

- 第二轮定向程序/兼容回归：319 PASS，0 FAIL，0 SKIP（10 个文件）。
- 通知 freshness：6 PASS，0 FAIL，0 SKIP，包含 supersede 后、新 outbox 前真实 SIGKILL。
- 新消息入口原生闭环：3 PASS，0 FAIL，0 SKIP：A→B、无 Topic 澄清、定时查询与既有 outbox。
- PR236 专项：3 PASS，0 FAIL，0 SKIP（也包含在原生风险回归中，不重复计数）。
- 原生风险组合共 46 项，首次 43 PASS / 3 FAIL；修复 inputHistory 合同后仅重跑受影响三项，3 PASS / 0 FAIL / 0 SKIP，未机械重复整组。
- 最后针对 schema/索引、覆盖、schedule、freshness 和恢复的必要安全复验：40 PASS / 0 FAIL / 0 SKIP（与上方重叠，不重复计数）。
- suite-map 完整性与 git diff --check 实跑；没有 CI、生产模型或真实钉钉发送。
- 脚本模型只证明程序接纳/状态/恢复协议，不证明真实语言理解质量。

## 51 项逐项覆盖状态

“定向”表示对应关键断言已实跑，不等于完整上线验收；“部分”保留尚缺的端到端或并发维度。
所有真实模型和外部效果均未计入完成。

| 编号 | 本轮状态 | 证据/仍缺范围 |
|---|---|---|
| T01 | 部分 | resident CAS、稳定命令和来源重复；多进程双入口全链仍待。 |
| T02 | 部分 | 六成员第三项后重开只补未确认；整批进程 kill 仍待。 |
| T03 | 部分 | 接纳回执、Host handoff、结果及通知故障点；全点位矩阵仍待。 |
| T04 | 部分 | 空 Owner 无完成事件，正式 complete 放行 B；组合故障仍待。 |
| T05 | 定向 | 旧 complete/reopen/新上下文证明拒绝误放行。 |
| T06 | 定向 | 迟到事件消费回读当前版本，不信旧成功。 |
| T07 | 部分 | 全域指令/Task 环检测；复杂多协调单并发仍待。 |
| T08 | 部分 | 取消门禁及旧候选拒发；全部旧 wake 组合仍待。 |
| T09 | 部分 | claim 最终门禁、Owner 控制可用；人工全入口矩阵仍待。 |
| T10 | 部分 | 部分应用/失败及澄清独占；整单终态汇总仍待。 |
| T11 | 定向 | 已接纳 legacy 禁止抢占并保留 operation identity。 |
| T12 | 定向 | unknown 沿旧通知回读，不换身份重发。 |
| T13 | 定向 | 未分类及 preserve 冲突拒绝；普通补充保留运行。 |
| T14 | 定向 | Host input scope、空 IDs 无法绕过、锁前等待。 |
| T15 | 定向 | 已有回执同 ID 异 payload 拒绝。 |
| T16 | 定向 | 混合消息讨论与协调 unit 分离、恢复归属保留。 |
| T17 | 部分 | 显式 v1→v2、身份/排空和回滚底座；完整迁移/旧包演练仍待。 |
| T18 | 部分 | 同连接事务及原 owner 围栏；完整非法 writer 故障矩阵仍待。 |
| T19 | 定向 | 生效版本、continue 新输入、旧结果不结新指令。 |
| T20 | 部分 | 原生无 Topic 承接与 Owner 完成共存；完整并发去重仍待。 |
| T21 | 部分 | 时间规则拒绝过去/非法；真实“9点”语言回放仍待。 |
| T22 | 定向 | 重扫、跨 revision slot 替代、最多一个开始实例。 |
| T23 | 部分 | 原子 slot/游标及恢复；全部提交故障点仍待。 |
| T24 | 部分 | 只读 job/结果恢复及 Host handoff；定时 task-command 未接入。 |
| T25 | 定向 | 旧 job fence、租约过期迟到结果拒绝。 |
| T26 | 定向 | future 改版固定旧实例、unstarted 替代、取消控版。 |
| T27 | 定向 | 取消/许可两种定序及恢复 unknown。 |
| T28 | 部分 | 假发送成功回执丢失沿旧 ID 回读；真实钉钉未验证。 |
| T29 | 定向 | 原生查询不 reopen、不加 runSequence、不造 Task/Owner 调用。 |
| T30 | 部分 | 已观察稳定 ID、缺失/越群拒绝；真实成员目录/重名语言仍待。 |
| T31 | 定向 | 多年遗漏合并、串行与一个等待积压可审计。 |
| T32 | 部分 | DST skip/first 和持久 UTC slot；全时钟异常组合仍待。 |
| T33 | 部分 | 许可/unknown 不刷新；service 自动刷新完整 outbox 故障链仍待。 |
| T34 | 部分 | schema/owner 前置检查；旧包实际启动演练仍待。 |
| T35 | 部分 | 无 Topic 接纳/恢复/投递原生通过；删除 Topic 联测仍待。 |
| T36 | 部分 | 无 Topic 复用现有 outbox 与 notification sender；同群混合并发仍待。 |
| T37 | 部分 | 原文分页、目录截断、缺上下文拒绝；真实误意图回放仍待。 |
| T38 | 定向 | complete 当前上下文/版本/覆盖与事件原子校验。 |
| T39 | 部分 | 业务/投递分账；双故障整批组合仍待。 |
| T40 | 部分 | continue/recover 共用 claim；完整人工竞态仍待。 |
| T41 | 定向 | 旧候选取消或 supersede 后动态许可拒发。 |
| T42 | 部分 | 许可后重开 unknown；完整网络调用前后 kill 矩阵仍待。 |
| T43 | 部分 | 保留原可信未发送重试合同及取消门禁；并发组合仍待。 |
| T44 | 定向 | future revision 保留 cursor/accepted slot，不重复查发。 |
| T45 | 部分 | 替代链/slot 指针/首次 claim 条件；三方并发故障全矩阵仍待。 |
| T46 | 定向 | refresh/permit 两种顺序及旧身份永久拒发。 |
| T47 | 定向 | supersede 后新 outbox 前 SIGKILL 恢复新身份。 |
| T48 | 定向 | reserved/clarify 旧链排除且不 settled；原生澄清入口已验证。 |
| T49 | 部分 | resident+dynamic 冻结 proof 原语已实现；受控 handoff facade 和恢复闭环未接通。 |
| T50 | 部分 | 解析/版本预检及部分应用冲突；全部中途冲突摘要仍待。 |
| T51 | 未完成 | time 分支已实现；message/business-event occurrence 联合合同尚未完成。 |

## 下一步与明确未完成项

1. 接通 rejected 来源显式 handoff 的受控 Host facade、动态 proof 回读及交回中状态恢复；
   禁止直接把 resident 结构校验当动态无命令真实性证明。
2. 关联原安排的澄清回复、其中第 N 个、局部暂停/撤销/顺序反转、兼容补充和跨单冲突决策。
3. 明确新建的冻结 Task 创建契约、创建/启动分离；定时 task-command 和三类 occurrence 触发合同。
4. 全部成员及计划/实例/通知参与的整单终态、缺结果查询和不重复业务承诺的最终 summary。
5. 迁移 CLI、能力/索引校验、兼容关闭模式及真正旧包/迁移失败/回滚演练。
6. 真实语言隔离回放需要先明确模型调用范围与许可；真实外部效果测试另需许可。

本轮没有访问拒绝、待审批动作或不确定的真实外部效果。所有代码仅在云端开发分支，无推送/PR/部署/合并/发版。
