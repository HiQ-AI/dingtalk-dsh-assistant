## 问题与结果

路由、决策和审阅持续累积在群主会话，增加输入体积及请求间干扰；确定性审阅失败的恢复缺少事前校验，执行计量也缺少跨会话、等待和缓存分项。本 PR 实施请求级协调会话、只读恢复预检、紧凑投影、批量结构错误反馈、已知工作位置传递及性能查询。业务状态和 Outbox 仍由 Host 原子提交。

此为草稿 PR：源码及本地验证已完成，真实流量和人工语义验收仍待完成，没有部署或发布。

## 实现

- `runtime.js:2229` / `topic-runtime.js:1057`：恢复前复用实际审阅构造，在 Task 锁内校验版本、待授权、待处理输入、流程及预算；失败保持系统等待、不创建模型会话。
- `coordination-sessions.js:23` / `runtime.js:1804`：每个 request 复用一个独立 Session，同群模型串行，入站路由优先。角色工具注册、原生 guard、请求/群身份及版本共同约束提交。终态先让成功工具结果落稳，再释放句柄；只保留原生审计日志。
- `topic-runtime.js:485` / `coordination-context.js`：紧凑目录与关联 Task 所有 Topic 分页；当前可见且完全相同的材料才能复用。过期、压缩移出和授权变动不能沿用已读状态。
- `topic-model.js` / `decision.js:294`：纯校验收集多字段、多动作问题，再进入既有原子提交；不增加每次必须调用的预检工具。
- `performance.js` / `store.js:349` / `http.js`：`GET /state/performance` 按日/会话/请求查询首流、模型/工具耗时、缓存分项、协调排队、等待、精确回复关联及会话交互字节。seed、重复及 replace 不重计；按会话持久化，缺失明确返回，不存正文。
- `coordination-resources.js` / `dws-adapter.js:193`：本请求精确消息、引用链和资源只读入口；无任意 shell。支持图片、UTF-8 文本及限定公网 HTTPS 文本，不支持的格式显式失败。
- `runtime.js:26`：仅验证已有 artifacts/evidence/handoff 中的绝对位置，派发前再检查版本；未知位置显式返回，不遍历猜测。

以上文件均位于 `packages/dingtalk-dsh-assistant/`；README 和既有部署 runbook 同步。

## 关键实现

`packages/dingtalk-dsh-assistant/coordination-sessions.js:5`

```javascript
export function createCoordinationStepGate(entry, isCurrent) {
  const yieldGate = createTaskReportStepGate({ isBlocked: () => entry.yieldRequested === true, isResolutionMessage: () => false })
  return (event, next) => entry.active && isCurrent(entry.request) ? yieldGate(event, next) : { kind: 'reject' }
}
```

让路时复用原生 Inbox 回填门禁，避免 pre-step 已 claim 的消息丢失；终态或失效请求拒绝继续模型执行。另一个原生反例证明 `restrict` 不能约束 scope-local 工具，因此同时使用单调执行 guard，不能用模拟工具注册器的成功代替权限验证。

## 验证

- [x] `pnpm test`：最终 **514 PASS、0 FAIL、0 SKIP**，包含 6 个真实 DSH AgentLoop/Session/ToolRuntime 生命周期用例，模型使用确定性适配器。见 `docs/acceptance/performance-flow-optimization/round-9-tests.log`。
- [x] `node scripts/build-web-client.mjs` 与 Web 产物 diff：exit 0；三个 `pnpm pack` 完成，独立 tar 清单、字节数、SHA256 读回。见同目录 `round-9-pack.log`、`round-7/package-readback.json`。
- [x] 原始 91 路由批次覆盖全部 81 条消息，在**同一当前快照**调用固定基线和新生成器：完整输入 P50 **32310→11021 B**、P95 **34971→13748 B**；正文、79 项目录、140 次关联 Topic 验证通过，续页次数不变。保留首次超预算实验。该快照不是当时审计快照，不声称历史状态还原或人工语义验收。见 `round-7/route-projection-summary.json`。
- [x] 反例覆盖跨群/跨请求/错误角色、旧 Agent、异步 post-execute、创建期间路由抢先、同请求恢复、重启幂等、持久化失败、跨日/缓存/seed/replace 和零业务副作用。失败轮次及重跑日志保留在 matrix。
- [ ] 真实供应商与钉钉业务 E2E、81 条人工语义真值、首次实质回复人工标注、冷缓存成本及真实响应收益尚未验证。
- [ ] 整体 glob 超时率低于 5% 尚未达成，见下述独立依赖。

## 独立依赖、风险与回滚

glob 根遍历属于官方 `deepseek-harness` 的 `packages/fs/tool-fs-search`。以 `dsh-v0.1.2-rc.1` 为基线，本地独立提交 `884bafd6589862a2ea14499adbaeb5dbc198771e` 已导出到 `docs/acceptance/performance-flow-optimization/search/dsh-glob-fixed-prefix.patch`，未向外部仓库推送、未发布、未安装。相关上游测试 124 PASS / 1 SKIP。22 条失败样本优化后约112–662ms，并与限定范围结果集一致；4 条宽目录仍超时、8 条无固定前缀不适用。插件变更不能冒充该工具已升级。

Domain 仍为 v8；性能记录及 waitingKind 历史是可选字段/记录，不回填旧数据。精确分位数、日区间和去重元数据仍随保留历史增长。新 Session 减少历史输入，但额外冷启动成本需要实流量对照。受限资源入口不支持 PDF/Office/音视频及登录文档，不能将其视作已读或据此放行任务。

当前只交付源码，未改在线 profile。后续试运行按 `docs/ops/resident-review-local-deployment.md` 做精确版本、进程、状态及入口核验；切换前备份，回滚恢复原包和对应备份，不只比对版本号。公开证据不包含业务正文、群/人员身份或原始搜索目录清单。
