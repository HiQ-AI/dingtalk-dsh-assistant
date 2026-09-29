## 问题与结果

入口可接纳 32 条验收但 Owner 只支持 16 条，阶段准备与结果声明分散，文件存在和阶段成功也不足以证明任务完成。本 PR 统一入参与领域合同，并把完成接纳改为逐项分派、领域核验、Host 保存业务回执。

复审已复现：调查明确“生产故障仍在”后，只写一份备忘录的混合流程仍能结案，通用业务检查调用次数为 0。现在这类组合拒绝完成；保存文档只验证保存项，工程与部署分别用对应证据完成各自验收。既有 Owner/Stage/Run 和效果账继续使用，不增加编排引擎。

## 实现

- `task-input-contract.js` 统一 1–32 条、单条 2000 字符及非空要求；入口、Owner、工程准备复用，追加/修订在写入前检查累计容量。历史数据只读，不裁剪。
- `task-workflow-contracts.js:6` 统一阶段准备、材料角色/容量、冻结 Schema、成功生产 Run 身份及结果字段校验。工程声明消费 `agent-investigation-result@1` / `investigation-result@2`，未知类型/版本前置拒绝；目录从权威结果合同派生，删除第二份手工 requiredOutputs。
- 调查 v6 提供真实验收 ID 对应的 findings/openItems/criterionReviews；完成检查按评估引用分派验收项。调查沿用逐项意见，工程按当前阶段引用匹配冻结要求和实际业务用例，通用/外部/投递先核实效果再验证自己承担的条目。Owner 只汇总，不能用其他领域的无关产物覆盖不足。
- `task-general-workflow.js` 提供原生零工具领域检查，保留材料整理的确定性快速路径。模型仅看本领域条目与证据；输入 128 KiB、输出 16 KiB/4096 tokens、超时 30 秒。Host 校验逐项覆盖及同项证据；无模型、超限、工具调用、协议异常或不足均拒绝。自定义检查器须绑定稳定身份。
- 正式清单继续核对实际文件字节、生产身份与投递回执，并保存独立 `businessValidation`。业务回执绑定决定、产物、运行/计划版本及实际规则摘要；模型不能伪造，Owner 完成接纳要求 accepted。
- 新通用 Workflow v6 / Owner v2、外部 Owner v2、投递 Workflow/Owner v2；历史工厂保留原摘要和执行恢复路径。当前完成准入修正规则另记 policyDigest，不改写旧 Run、不重放副作用。失败诊断明确责任与下一步，既有重试预算和未知效果对账规则保留。
- README、节点合同与部署说明同步领域受理/拒收、合法结局、返修责任及 Owner/领域/节点/Host/渠道分工；任务整体仍要求全部验收项满足。

## 关键实现

`packages/dingtalk-dsh-assistant/task-workflow-contracts.js:292`

```javascript
      for (const contractId of new Set(stages.map(item => item.contractId))) {
        const domainStages = stages.filter(item => item.contractId === contractId)
        const domainRefs = new Set(domainStages.flatMap(item => [item.stage.outputRef, ...(item.stage.evidenceRefs ?? [])]))
        const acceptanceItems = items.flatMap(item => {
          const assessment = decision.assessments.find(value => value.itemId === item.itemId)
          const evidenceRefs = assessment.evidenceRefs.filter(ref => domainRefs.has(ref))
          return evidenceRefs.length ? [{ itemId: item.itemId, criterion: item.criterion, evidenceRefs }] : []
        })
```

引用只分派责任；每个被引用领域必须通过对应条目的检查。未承担条目的阶段仍校验自身效果，避免让写文件阶段承担整个工程目标，也避免混合流程跳过检查。

`packages/dingtalk-dsh-assistant/task-workflow-contracts.js:307`

```javascript
        for (const context of contexts.filter(item => item.contract.id === contractId)) {
          const policy = completionPolicy(context.contract)
          if (!policy || await policy.validateCompletion({ ...context, requirement: domainRequirement,
            decision: domainDecision, stages: domainStages, acceptanceItems, verifyAcceptance: verifyDomain }) !== true) return false
        }
```

原执行合同与当前接纳策略分别记录。只有全部检查通过，Host 才生成绑定当前状态的业务回执并允许 Owner 持久化完成清单。

## 验证

- [x] `pnpm install --frozen-lockfile`：隔离 worktree 安装成功。
- [x] 服务入口 8/8：SQLite/Controller/Owner/效果账/文件实际运行；无关写入、错项及调查不足引用被拒绝，有效保存完成且清单 accepted。包含默认原生检查协议夹具和通用 v4/v5 正式关闭重启，核对冻结摘要与副作用不重放。
- [x] 原生领域检查协议 16/16：逐项引用、容量、超时、非法输出及工具调用等反例；模型流为夹具，不是线上模型语义质量评估。
- [x] 工程→合并→失败部署→重建定向用例 1/1：工程保存、UAT 部署分别验收；成功前缀不重跑，部署与重建各一次，最终两项业务回执持久化。
- [x] 第五轮 24 文件 555/555 通过；随后新增同领域多工程阶段反例，确认旧策略误拒有效分工。修复后定向 1/1，未承担条目的损坏工程证明仍被拒绝。
- [x] `pwsh -NoProfile -File docs/acceptance/workflow-domain-contracts/scripts/verify.ps1 -Suite all`：最终第七轮 24 文件，555/555 PASS，0 FAIL、0 SKIP，303324.5197 ms；完整输出 `round-7/final.log`。最终工程分工修正已包含，矩阵各用例最新轮全绿。
- [ ] 未运行全仓测试、真实模型、真实钉钉发送、共享 UAT 或正式实例部署；外部系统为隔离替身，当前不声称已上线或真实业务验证通过。

## 风险与边界

没有新增依赖、数据库 schema 或历史数据迁移，不涉及沙箱和网关。结构清单、领域业务接纳和渠道投递分别留证；模型协议通过不能证明任意自然语言目标正确。新增领域检查可能因缺配置、容量超限或证据不足阻止完成，应补齐对应条件，不能降级为只看工具成功。

旧执行摘要保持，历史终态不回填业务回执；未完成旧任务采用当前修正后的准入规则，可能需要补证。若后续部署后回退，先排空新调查/通用/投递版本及外部 Owner v2 的活动任务，或恢复升级前备份，不能让旧代码处理它不认识的冻结定义。本 PR 只交付代码与本地验收，不合并或部署。完整证据见 `docs/acceptance/workflow-domain-contracts/`，历轮失败记录保留。
