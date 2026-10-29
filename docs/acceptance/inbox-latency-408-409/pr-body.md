## 问题与结果

修复 Topic 接纳任务变更时误等待新 Owner 的竞态，并补齐按 ID 读取归档身份、工具参数反馈和 Host 子阶段计时。

原链路在 `task.revise/reopen/control` 提交后自动调度，随后 `cancelLiveTask` 异步查询/取消，再按 taskId 获取在途 promise；可命中刚启动的新 Owner。基线临时 SQLite/service 实验确定性复现 `ownerRuns=2 / cancelObservedRun=2 / admissionSettledWhileNewOwnerBlocked=false`。这证明受控交错下存在错误等待依赖，不证明现场 #408 的 148 秒全部由它造成。原双 Owner gate 测试在基线也通过，因此不能替代 execution.list 强制交错反例。

归档缺口位于活动缓存与协调上下文，而非底层 `task.get`：后者原本就按 ID 回查归档表。此前不存在任务会叠加 wrong_group/not_completed；缺 taskIds 会产生原生类型错误；原文覆盖失败缺少可修正片段。

## 实现

- 同任务 admission hold 覆盖提交、固定旧轮排空、来源材料物化；scheduler 与 Owner/Execution 的异步 claim 前均检查 hold，不在持有旧 flight 时等待 hold，避免自锁。其他任务仍可推进。
- 保留现有同 Topic 的 pending-decision 互斥（第二请求 `topic-busy`），不把拒绝擅改为双请求自动接纳；保留任务版本、来源、授权、群归属及原任务/会话身份。
- 明确 ID 时按需读冷归档，同群仅返回必要身份、归档戳和空 `allowedActions`；跨群先拒绝，不恢复归档。错误互斥区分不存在、跨群、归档和状态。
- `group_task_context_get` 以 schema 和运行时校验 1–8 个唯一非空 taskIds，返回结构化 issues；路由遗漏返回 UTF-16 左闭右开 `start/end/quote`，不放宽原文覆盖。
- Host 真实 await 边界记录 `task-commit/old-drain/materialize`，异常也闭合；严格按 stage 校验 phase。投影沿用既有字段，父子跨度不相加，不补造历史计时或 TTFT。
- 修复材料失败重启后的等值请求键序冲突：真实回读 source 持久 action，经既有请求身份校验后复用旧 decision；不更换全局 fingerprint 或历史收据摘要算法。

## 关键实现

`packages/dingtalk-dsh-assistant/task-session-service.js:504`

```javascript
function admitTask(taskId, action) {
  const previous = admissions.get(taskId) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(async () => {
    admissionHolds.add(taskId)
    const oldTask = inflightTasks.get(taskId), oldExecutions = new Map(inflightExecutions)
    try { return await action(oldTask, oldExecutions) }
    finally {
      admissionHolds.delete(taskId)
      if (!closed) void schedulePending()
    }
  })
  admissions.set(taskId, pending)
  pending.finally(() => { if (admissions.get(taskId) === pending) admissions.delete(taskId) }).catch(() => {})
  return pending
}
```

在任务动作前冻结旧轮等待边界，finally 释放屏障并调度；取消后不再按 taskId 重新取可能属于新代的 promise。已越同步入口的 Owner/Execution 启动链在 claim 前再次退让，scheduler 也跳过 held 候选。

`packages/dingtalk-dsh-assistant/task-session-service.js:1471`

```javascript
const persistedAction = (await query('source.get', { sourceId })).requestIdentity.action
const accepted = previous && previousRecord
  ? { status: 'duplicate', topicId: previousTopic.topicId, record: previousRecord }
  : await residentStore.submitWebTaskInput({ groupId, requestId: args.requestId, text, action: persistedAction, topicRefs: persistedAction.topicRefs })
```

持久化会规范化键序，而历史 fingerprint 保留原始 JSON 顺序。局部复用经请求身份校验的旧记录，允许同值重试并继续拒绝异值，不重写历史 hash 或重复成功效果。

## 验证

所有运行使用隔离工作树和临时数据；native profile 仅作为已安装依赖入口，通知为桩，不启动正式 profile。

- [x] `node --test test/task-topic-routing-native.test.js`（指定 native profile）→ 最终 21/21 PASS、0 fail/cancelled/skip，54,005.6761 ms。覆盖冷归档/8种非法参数、claim 提交前后门闩、execution.list 强制交错、旧新 Owner 门闩、真实旧键序 writer 夹具、材料失败/优雅重启与异值拒绝、同 Topic busy/异任务独立、失败跨度与到期恢复。
- [x] `node --test test/task-archive-scheduling.test.js test/coordination-resources.test.js test/performance.test.js` → 修复 diff 50/50 PASS、0 fail/cancelled/skip，1,629.0329 ms；与基线同名组结果分开记录。
- [x] `node --test test/topic-runtime.test.js` → 143/143 PASS；Lead 独立抽验遗漏 UTF-16、互斥错误、跨群上下文和来源授权 4/4 PASS，953.6322 ms。相关源码未再变化，复用有效结果。
- [x] `node --test --test-name-pattern='任务关联摘要不复制原文' test/runtime-history.test.js` → 历史兼容单项 1 PASS，1,153.35 ms；不把历史工具合同改成新协调工具返回结构。
- [x] `node docs/acceptance/inbox-latency-408-409/scripts/owner-admission-race.mjs --material-failure` → Lead 独立实跑 exit 0：失败后 revision=2/ownerRuns=1；修复材料路径并优雅重启后 ownerRuns=2；相同请求 REPLAY error=null/revision=2/ownerRuns=2/submissions=1，快照内容实际回读。
- [x] 平台脚本 `--claim-race/--claim-committed/--held-open-slot/--owner-wake` → 各受控实验 exit 0；提交前 claim 被账本拒绝、提交后旧 binding 非 current；空槽 held 队列在 300ms 采样内不新增 claim；Owner 已越入口遇 hold 后先退让，释放后仅 claim/run 一次。Lead 回读断言，独立 reviewer 核证明范围。
- [x] 独立只读审查当前源码、测试与脚本增量：无剩余已证阻断；初版旧序 fixture 不足已补为真实 Store 写入再恢复。历史 timeout、并行 SyntaxError、旧断言失败和空槽夹具超时均保留，不以最终通过抹除。
- [x] `node --test --test-name-pattern='native completion race|native service cancellation stops|native requirement update resumes|native capacity queues promote|native session creation failure' test/task-session-service-native.test.js`（指定 native profile）→ Lead 独立实跑 9/9 PASS、0 fail/cancelled/skip，115,591.5036 ms，exit 0；真实原生执行进程取消排空、旧结果 fence、四组并发容量和创建失败有界恢复均通过，完整输出已读回。
- [x] `git diff --check` 与 service 语法检查通过。
- [ ] 生产部署、CI、真实消息/通知与 #408/#409 复跑：未执行，本轮无此授权且禁止重放原消息；不声称已上线或现场耗时已降低。

完整命令和历轮失败/修复重跑见 `docs/acceptance/inbox-latency-408-409/round-*.md` 与 `matrix.csv`。21/50 项采用测试成员原始 summary 回执，未单独保存完整 stdout；Lead 独立回读关键断言并实跑强制交错与材料恢复，不冒充独立重跑全部测试。

## 风险与边界

- 并发/恢复改变调度时序；只按同任务隔离，保留原幂等、版本 fence、原生取消与持久恢复机制。不新增 schema、配置、依赖或数据库迁移。回滚为还原本 PR 源码及文档；已存在的可选 Host phase 数据仍为诊断记录，不触发业务重放。
- 部分竞态使用 Owner/Execution 桩；真实账本 `execution.current=false` 不等于真实 driver/外部工具零副作用证明。空槽 300ms 观察不是全局无空转保证；Owner wake 脚本以当前源码栈行号定位，代码移动需同步夹具。
- 材料与旧键序夹具仅验证优雅关闭重启，不覆盖突然 crash 或全部历史版本 DB 迁移。cancel 失败用例的旧 Owner 已排空，fixture 调整 retry deadline 只验证恢复分支，不当作真实等待时长。
- Host 时钟包含埋点存储开销；task-commit 抛错及埋点存储自身失败没有新增直接故障注入测试。未测现场频率/收益，不做模型 effort 或无实测提示词精简。
- 默认任务目录仍不列归档，明确 ID 只读归档不赋予执行权限；不恢复归档任务、不新建替代任务、不重发历史通知。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
