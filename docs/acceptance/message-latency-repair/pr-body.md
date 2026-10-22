## 问题与结果

短延时只读查询会被无用详情读取和工具参数试错拖过约定时间。今日“三分钟后”样本从消息发生到澄清送达 219.088 秒：前两次规划分别 46.098/68.516 秒，均耗尽 8 步未提交，重试间隔合计 74.679 秒；本地工具实际仅耗时 129/96 毫秒。另两条 114.182/119.390 秒的确认回复，因审阅交叉字段规则未公开而重复提交 5/3 次。

本 PR 让纯查询复用已读目录、公开工具实际约束，保留消息原时间并按既有补执行窗口处理系统迟到。受控原生 Host 中，17 任务一次协调调用直接提交；41 任务补读一页后提交。实际模型与线上耗时收益尚未验证。

## 实现与关键位置

- `independent-coordination-planner.js:11` 与 `independent-coordination-service.js:26` 共用上下文 schema，范围不再靠模型试错；初始上下文含来源消息时间和当前处理时间。
- `independent-coordination-service.js:179` 仅放宽纯 read-query 的目录观察。条件续办、任务变更仍要求完整合同与版本；未读/跨群目标拒绝。
- `independent-coordination-service.js:206` 和 `coordination-schedules.js:274` 保留原单次时间；默认 15 分钟补执行，超窗过期，不改次日。真正早于原消息的时间和缺失来源时间仍拒绝。
- `decision.js:31`、`topic-runtime.js:946/978` 说明回复类型/历史确认替换和分页条数/偏移；只补充说明，不移除运行时拒绝规则。
- `independent-coordination-service.js:423`、`task-session-service.js:544` 在持久成功后清理原规划告警，保留 attemptCount。README 和运维说明同步。

以上源码路径均位于 `packages/dingtalk-dsh-assistant/`。

## 关键实现

`packages/dingtalk-dsh-assistant/independent-coordination-planner.js:11`

```javascript
export const coordinationContextSchema = z.strictObject({
  offset: contextOffset.optional(), limit: z.number().int().min(1).max(50).optional(),
  taskIds: z.array(nonempty).max(8).optional(), coordinationIds: z.array(nonempty).max(4).optional(),
  sourceOffset: contextOffset.optional(), arrangementSourceOffset: contextOffset.optional(),
  arrangementOffset: contextOffset.optional(), memberOffset: contextOffset.optional(),
  arrangementSourceUnitId: nonempty.optional(), arrangementSourceUnitRevision: z.number().int().positive().optional(),
}).refine(args => (args.arrangementSourceUnitId === undefined) === (args.arrangementSourceUnitRevision === undefined),
  'arrangementSourceUnitId and arrangementSourceUnitRevision must be provided together')
```

既有 schema 投影器把模型不支持的范围关键词转换为说明，执行侧仍用同一 schema 严格解析。

`packages/dingtalk-dsh-assistant/independent-coordination-service.js:183`

```javascript
    for (const id of targetIds) {
      const previous = observed.get(id), current = await query('task.get', { taskId: id })
      if (!previous && !(directoryOnly && catalogObservations.get(request.reservationId)?.has(id))) fail('COORDINATION_CONTEXT_REQUIRED')
      if (!current || current.groupId !== request.groupId || current.archivedAt) fail('COORDINATION_TASK_SCOPE')
      // 纯查询只冻结目标身份，到时读取最新事实；任何附带任务动作仍须完整合同与版本检查。
      if (!directoryOnly && ['requirementRevision','controlRevision','runSequence','contextRevision'].some(key => (previous[key] ?? 0) !== (current[key] ?? 0))) fail('DYNAMIC_TASK_REVISION_STALE')
    }
```

只读安排不为获取完整需求和历史结果消耗模型轮次，仍在接纳时检查任务身份与群范围。

`packages/dingtalk-dsh-assistant/independent-coordination-service.js:206`

```javascript
      if (proposal.rule.kind === 'once' && Date.parse(proposal.rule.at) <= Date.now()) {
        const sourceTime = new Date(request.sourceSnapshot.occurredAt ?? NaN).getTime()
        if (!Number.isFinite(sourceTime) || Date.parse(proposal.rule.at) < Math.floor(sourceTime / 1000) * 1000) fail('DYNAMIC_COORDINATION_TIME_PAST')
      }
```

只允许由处理延迟造成的过时交给既有账本窗口裁决，不把“系统晚处理”变成用户需要重新授权的业务选择。

## 验证

- [x] `node --test @unitFiles`，文件清单 `docs/acceptance/message-latency-repair/round-2/unit-files.txt`：469 PASS、0 FAIL、0 SKIP。覆盖未读/跨群拒绝、任务变更及条件续办完整合同、回复审阅和分页边界。
- [x] 设置仓库 `DSH_NATIVE_TEST_PROFILE` 后，`node --test --test-concurrency=1 @nativeFiles`：47 PASS、0 FAIL、0 SKIP。清单见 `round-3/native-files.txt`；17/41任务、原 Owner、原计划时间、通知身份和告警恢复均通过。
- [x] `pnpm test:release-smoke`：14 PASS、0 FAIL、0 SKIP，包括真实 tgz 任务和解压 Resident 启动健康。
- [x] `node scripts/test-suites.mjs check`：299 文件各一次、历史 3、删除 0；`git diff --check` 与审计脚本语法检查通过。
- [ ] 真实模型消息耗时及钉钉业务送达：本轮未部署、未发信或重放。受控调用数不冒充线上提速。

最终三组共 530 项通过，迭代重跑不累加。完整现场阶段拆分、正常反例及结果见 `docs/acceptance/message-latency-repair/report.md`、`round-1/latency-audit.md`、`round-3.md` 和 `matrix.csv`；未提交原始业务正文、人员标识或模型流。

## 风险与边界

正常多候选路由约 50 秒未发现重复页或参数错误，不能把所有模型慢都归于本修复；另有约 399 秒消息至路由间隔和投递网络耗时缺少足够时钟/网络证据，保留为未收敛项。性能 API 标为 incomplete，样本不代表全日总体。

不增加 8 步上限、不缩短退避、不放宽业务动作权限；无 schema/配置迁移。回退代码可恢复旧行为，已持久化计划和通知沿用既有身份，不自动重判或重发历史澄清。本轮无 CI、部署、发布或合并。
