# 任务协调 v1.3：实施检查点

依据：2026-10-21 用户提供的《钉钉 DSH 任务协调层建设方案》完整 v1.3 正文。
重新核查的 main 基线：94f9972。分支：feat/coordination-v1.3。

**本检查点不是完整首版，也没有通过 T01–T51 上线矩阵。不得部署。**
最新实施、测试及逐项覆盖以 [第二轮交接](../acceptance/task-coordination-v1.3/round-2.md) 为准；下方保留首轮 63849ec 的历史记录，不能把首轮未完成清单当作当前状态。
不修改 Task Owner 默认模型、执行模型、DSH 核心或 Web 创建入口。
没有访问百部环境，没有群外发、生产数据修改、部署、合并、发版或创建 PR。

## 已编码的底座

- 动态账本 schema v2；同一连接、原 owner incarnation 围栏和事务入口。
  v1 默认拒绝打开，显式 `migrate:true` 在身份、marker、ingress 绑定和 owner 检查后迁移。
  活动执行、未排空 Task、未知操作或发送不确定时拒绝迁移。
  DDL 和 user_version 在同一事务提交；旧 v1 代码不能读取 v2。
- 独立协调表、来源 unit/revision 保留、固定成员、原话快照和冻结命令。
  同来源异正文拒绝；task command 使用协调单/指令命名空间及完整摘要回执。
  全批预检、同群检查、明确 preserve/replan、指令和任务级全域循环检查。
  应用按成员事务进行；已应用成员不重放，后项失败不回滚前项。
- 依赖回读当前 Task 版本和正式 complete 回执；reopen 使旧证明失效。
  execution claim 在资源锁前检查；新 execution/continue 记录指令集合。
  依赖等待不作为执行故障。
- 独立 schedule、UTC slot、occurrence、read-query job，持久游标及到期索引。
  单次、每日和每周；默认宽限 15 分钟、周期合并遗漏、串行认领。
  时区通过 IANA/Intl 校验；DST 缺失时刻跳过、重复时刻只用第一次。
  查询只读 Task 投影，保存 observedAt；不创建 Task、不 reopen、不唤醒 Owner。
  作业租约、attempt/fence 与实例控制版本校验；计划改版不误伤已开始的作业。
- 扩展已有 notification 合同，支持无 Task/Topic 的 coordination 事实。
  复用已有 notification.start 作为事务发送许可入口，绑定 payload、attempt/fence
  和实例控制版本；取消先提交则拒发，许可后崩溃转 unknown，旧身份只回读。
  查询结果和通知投递分别记账。
- 新模块列入发布文件清单，测试分类映射保留所有既有测试。

## 尚未完成：必须继续实施

1. resident 的 source unit/revision CAS 保留、dispatchOwner fence、跨账本保留凭据、
   needs_clarification/settled 分离和显式安全交回；目前来源保留仅在动态账本。
   Topic 正常应用、恢复和 projectSource 尚未接通新归属检查。
   因此没有开放运行时协调接纳入口，不能把当前 reserve API 当作完整唯一派发保证。
2. 消息语义入口、有限模型上下文和独立模型配置、稳定目标与群成员解析、
   最小澄清、用户改口、部分暂停、明确新建及创建/启动分离。
3. 规范化任务适配仍调用原 Task reducer，尚未完成所有运行状态的反馈/继续/reopen
   分类；新增依赖门禁保守作用于相关 Task，未达到精确 execution/inputVersion
   适用范围合同。完成覆盖还需从 Owner 接纳到执行证据建立完整可验证链。
4. 全局完成事件流、消费游标、持续 dispatcher、依赖释放 wake、恢复扫描与队列背压。
   当前支持事务 API 和回读，不是已接入运行循环的完整调度服务。
5. Schedule 当前只支持 read-query 动作。时间任务命令、三类触发联合合同、
   slot 替代链、修改本次投递、跨版本同 slot 的替代/拒绝策略仍需补全。
   合并遗漏保存时间范围；精确合并数量、过期通知及终态聚合还需完成。
6. 未许可候选的 freshnessWindow 刷新和原子 supersede、通知事件唯一索引、
   resident outbox 冻结/恢复接入、独立 summary 归属与查询观察界面。
   当前可复用现有发送器，但没有新增实际通知发送入口。
7. 显式迁移目前是 Host store 参数；尚无完整离线迁移命令、故障注入演练及
   兼容关闭/回滚操作流程。需验证 v2 索引和持久 writer 能力合同。
8. T01–T51 全矩阵、真实语言隔离回放、完整原生端到端与迁移回滚演练。
   脚本模型测试不等于真实模型理解验证；没有真实模型调用或真实钉钉送达证据。

## 本次验证

- 新增账本 10 项、时间规则 3 项确定性测试通过，包括一次真实子进程 SIGKILL。
  覆盖六成员第三项后恢复、部分冲突、A 正式完成后 B、旧证明失效、
  无 Topic 查询、取消/发送许可两种顺序、作业旧代际拒绝和 DST。
- 既有 dynamic-task-store 96 项通过。
- 指定仓库隔离 native profile 后，task-session-service-native、
  task-notification-retry-native、task-session-package-native 共 43 项通过，0 跳过。
- task-notification-delivery 27 项通过。
- suite-map 完整性检查通过；没有运行 CI、没有机械重复全量。

这些是具体底座和兼容性证据，不代表对应编号的端到端验收全部通过。
原生测试使用真实 Host/Session/SQLite 和脚本模型，不连接真实生产模型或钉钉。
