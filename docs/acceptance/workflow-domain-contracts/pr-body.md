## 问题与结果

Web 可接纳 32 条验收而 Owner 最多接纳 16 条；阶段准备分散，调查结论缺少逐项交接，成功引用及文件清单也不足以代表当前任务已交付。本次统一入口合同与领域准备，将前序结果绑定到准确任务、阶段、冻结定义和需求版本，并在 Owner 完成前核对逐项证据和正式产物。

例如调查标记某项证据不足后，Owner 不能仅引用同一调查改评为满足；必须引用随后阶段的有效证据。多次追加累计超过 32 条时，在修改需求前整批拒绝，避免接纳后无法启动。

## 实现

- `task-input-contract.js` 统一 1–32 条、单条 2000 字符及非空校验；消息、Web、Owner、工程准备复用，底层追加和服务修订均校验累计容量。
- 各领域提供阶段准备合同；`task-workflow-contracts.js` 在准备前后核对声明的材料约束，以冻结首节点 Schema 校验结果，再通过当前成功阶段构造 typed handoff。`workflow-service.js` 的首阶段及后续阶段走同一入口。
- `agent-work.js` 的新调查 v6 增加 findings、openItems、criterionReviews，使用 Host 提供的真实验收 ID；旧 v5 保留固定摘要与独立恢复路径。启动加载后续交接或未完成 Owner 所需的成功历史定义。
- 正式清单关联成功阶段、结果合同、逐项验收、当前文件生产节点与实际字节；要求外发时仍核对独立回执。Owner 接纳完成时保存清单引用，任务详情返回当前版本引用。
- 执行失败诊断保存类别、责任和下一步；不改变既有重试白名单、预算或未知外部效果对账规则。README、节点合同和迁移说明同步更新。

## 关键实现

`packages/dingtalk-dsh-assistant/task-workflow-contracts.js:61`

```javascript
  const state = await controller.state(stage.runId), final = state?.nodes?.at(-1)
  if (state?.run?.taskId !== taskId || state.run.runId !== stage.runId || state.run.status !== 'succeeded'
    || state.run.workflowId !== stage.workflowId || state.run.workflowDigest !== stage.workflowDigest
    || state.pendingInputCount || final?.status !== 'succeeded' || final.outputRef !== stage.outputRef
    || final.generation !== state.run.generation) throw executionError('TASK_STAGE_HANDOFF_STALE')
```

交接必须来自当前成功的生产 Run 和最终节点，不能只凭一个可读取的输出引用继续执行。

## 验证

- [x] `pnpm install --frozen-lockfile`：隔离 worktree 安装成功。
- [x] 服务集成四文件 165/165、合同与执行十五文件 307/307、新增阶段合同六项全部通过；旧 v5 成功前序使用真实存储关闭后经正式 Host 重启读取。
- [x] 独立复审针对调查不足覆写、合并材料超限、成功历史定义恢复和最终清单身份校验补齐拒绝反例。
- [x] `pwsh -NoProfile -File docs/acceptance/workflow-domain-contracts/scripts/verify.ps1 -Suite all`：22 个相关测试文件，504/504 通过，0 fail、0 skip，耗时 180284 ms；最终证据 `round-3/final.log`。
- [ ] 未运行真实模型、真实钉钉发送、共享 UAT 或本地正式实例部署；当前证据为隔离测试，不声称这些业务路径已上线验证。

## 风险与边界

不引入新依赖、数据库 schema 或历史数据迁移，不涉及沙箱和网关。清单证明结构与证据绑定，不能自动证明自然语言业务语义；仍由领域合同和 Owner 审阅。

v5 历史输入和结果保留原定义，不补造 v6 字段；历史超限验收可读且不裁剪，新追加须满足当前容量。代码尚未部署；若后续部署后回退，应先排空新增 v6 任务或恢复升级前备份，不能让不支持 v6 的旧代码继续处理新运行。验收记录位于 `docs/acceptance/workflow-domain-contracts/`。
