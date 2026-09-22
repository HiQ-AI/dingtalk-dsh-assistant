## 背景与目标

实施流程编排方案：将计划、节点传参、阶段产出、业务验收和通知中转变成 Host 可校验的契约，明确模型语义判断与确定性脚本的职责。基于 main 的 83fc504；不合并、不发版、不部署，不操作真实钉钉渠道或生产存储。

## 改动与机制

- `task-plan.js`、`task-result.js`、`runtime.js`：Host 准备稳定 criterionId/stageId，严格绑定来源、workflow、plan/input/run 版本；阶段引用登记产物和证据，完成逐项验收。依赖失效传播到下游，跨版本保留需要连续审计链，未引用/跨阶段证据不能夹带通过。
- `task-reports.js`、`topic-runtime.js`：统一 Zod 与工具 schema；received、reviewStatus、applicationStatus 分离。未知系统错误阻塞而不要求业务返工；完成已提交但报告回执未结算时按原 submission 恢复。
- `runtime.js`、`task-actions.js`：完成与通知意图同次落盘；恢复使用固定 Outbox 身份，非法草稿不回滚业务成功，历史无意图不补发。取消先保存 stopRequest，未知动作只对账，不宣称回滚。动作账本仅覆盖 Host 注册适配器。
- `topic-model.js`、`store.js`、`topic-runtime.js`：Decision 最多三次明确瞬时故障重试，未知结果 blocked；恢复必须命中 failureOperationId，已应用动作不能解锁另一失败动作。
- `task-checks.js`、`coordination-context.js`：有界只读 SHA256 检查，校验真实路径、文件变化及版本；材料 manifest 描述当前 surface 可见分页与缺口，压缩摘要不能冒充正文。
- `task-permits.js`、`coordination-sessions.js`：实际 idle 后归还许可，所有恢复入口和 pre-step 共用门禁；Goal 耗尽不自动扩轮；每群有限连续 route 派发保证审阅获得机会。
- 存储升级 v9，提供 v8→v9 独立目标迁移及冻结 v8 schema；历史不伪造成功，活动任务需显式恢复新会话与新计划。看板、任务表、HTTP 使用真实 outcome 和有效阶段证据，取消不显示全部验收通过。
- 同步 README、节点 API 契约、迁移 runbook、fake LLM 与隔离 DSH 验收脚本。

## 关键实现

`packages/dingtalk-dsh-assistant/task-permits.js:10`：排空中的旧许可仍占容量，不能被快速审阅结果绕过。

```js
if (holders.has(taskId)) return draining.has(taskId) ? undefined : holders.get(taskId)
if (!queue.includes(taskId)) queue.push(taskId)
if (queue[0] !== taskId || holders.size >= limit()) return undefined
```

`packages/dingtalk-dsh-assistant/task-reports.js:96`：完成恢复同时核对版本、结果和原提交身份。

```js
const committed = matchesCurrent(task, report) && task.state === 'completed' && task.outcome === 'succeeded'
  && report.reportType === 'result' && report.value.status === 'completed' && fingerprint(task.result) === fingerprint(report.value)
  && task.executionEvents?.some(event => event.kind === 'task-completed' && event.submissionId === report.submissionId && event.inputVersion === report.inputVersion && event.runSequence === report.runSequence)
```

## 验证与证据

- [x] `node --test --test-timeout=30000 --test-reporter=spec`：596/596 通过，0 fail/cancelled/skipped，86.60 秒；包含真实 DSH AgentLoop/Goal、JSON backend 迁移和真实子进程中断后的动作对账。记录于 `docs/acceptance/workflow-orchestration/round-11.md`。
- [x] `node docs/acceptance/workflow-orchestration/scripts/replay-coordination-load.mjs`：真实新旧队列模块在 0.5×/1×/2× 各三轮，共18次确定性回放通过；2× review P95 从920降至0虚拟毫秒，route P95从0增至240，总时长不变。不能推论真实吞吐或token节省。
- [x] `verify-observer-browser.mjs <workspace-dependencies-node_modules>`：隔离 headless Edge 真实 React 渲染10项通过，覆盖四种终态、四种通知状态、同名阶段稳定身份、键盘、390px中文、空态及错误；API及DSH外壳为替身。
- [x] `node scripts/build-web-client.mjs` 与生成文件 diff 检查：无生成漂移；三个 workspace 包 `pnpm pack` 成功，tar 清单含新增模块；包未发布。
- [x] `node docs/acceptance/topic-driven-processing/scripts/verify-topic-dsh.mjs <已安装DSH目录>`：隔离原生 DSH 0.1.2-rc.1 全链退出0；独立磁盘读回 domain9/contract2/succeeded/planRevision1，原生工具日志有 prepare1/register1/checkpoint3/result1；重复请求 Task 仍1个，真实渠道写入关闭。详见 round-12.md。
- [ ] 真实钉钉引用/@/附件/发送回读、生产 profile 迁移与部署：用户明确本轮先完成本地验证与PR，未执行。

## 风险、回滚与未覆盖

- v9 不支持原地覆盖或让旧 Runtime 打开新存储。迁移前停写、源备份、自检、独立转换和 SDK 回读；新存储开始接收业务后不能简单恢复旧快照，否则可能丢输入或重做外部动作。见 `docs/ops/workflow-storage-migration.md`。
- action ledger 不涵盖未接入的任意 shell/SQL/部署，不承诺外部 exactly-once；独立文件摘要一致也不等于业务正确。模型语义正确性仍需真实场景验收。
- 公平性将部分等待转移给 route，不等于吞吐提升。局部UI严格审计有既有 DESIGN.md 缺失项；本次沿用视觉并记录等效范围，未宣称全站设计合规。
- 完整 matrix 和失败修复历程位于 `docs/acceptance/workflow-orchestration/`，最终结论只覆盖本地与隔离范围。
