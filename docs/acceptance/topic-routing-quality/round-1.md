# 第 1 轮：实现中的基线与增量证据

日期：2026-11-03

## 结果边界

本轮记录在途实施成员已回传的实际结果，不宣告功能完成或最终回归全绿。所有测试证据绑定 `HEAD c80d42bf747cb950aa03ab7906194123bfc5683a` 加当时共享工作树中的未提交改动；HEAD 本身不包含这些改动。测试文件和共享产品源码仍在变化，报告只描述成员各自执行时的源码状态，不可当作整合后源码验证。

没有运行真实模型或付费评估。评分器、场景夹具、脚本模型及原生 Host 合同验证不能证明真实语义准确率、候选召回质量或真实钉钉运行结果。

## 用例证据

### 历史 Topic 多词召回

实现前命令：

```powershell
node --test test/topic-recall-search.test.js
```

在 `HEAD c80d42bf` 且 runtime 尚未修改、测试仅含两项基线断言时，结果为 0/2 通过、2/2 失败：

- `多词召回按命中数排序并给出逐字段依据，分页稳定`：返回 `queries` 为 undefined；新多词合同尚未实现。
- `原目录和整串查询语义不变，错误的多词请求拒绝`：多词请求被忽略，返回 total=4 而非预期 0。

随后 runtime 增加实现及第三项首包回归，成员报告同一命令 3/3 通过：涵盖命中数排序/字段依据/分页、原目录与整串 query 兼容及非法输入拒绝、引用优先和首屏外历史候选召回。该结果是实现中的增量，不是最终源码复验，也不代表真实模型最终选择正确。两次执行有不同测试文件内容/源码状态，不应将 2 项失败与 3 项通过误认为同一快照。

### Topic runtime 旧合同

并行实现期命令：

```powershell
node --test test/topic-runtime.test.js
```

成员回报 173/181 通过、8 失败；失败集中于旧 `workflowRefs` / `workflowReason` 输入与新决策合同/schema 不兼容。原目录及关联分页通过。该运行与核心决策合同变更并行，8 个失败已交 core 调整 workflow 夹具并复验；此处记录为失败，不视为预期豁免，也不视为最终结果。后续需回读 core 修复后的运行证据。

### 评估评分器

命令：

```powershell
node --test test/topic-routing-eval.test.js
```

routing-eval 报告 4 pass / 0 skip，覆盖 family/input 防泄漏、预测输入标签隔离、路由/动作/候选召回分项评分，以及动态新 Topic 按来源分区比较。场景夹具当前 32 条，标签尚未独立复审；provider/完整 runner 仍在实现。此项证明评分器合同测试通过，不是模型质量得分。

### 原生 Host 评估入口

命令：

```powershell
$env:DSH_NATIVE_TEST_PROFILE = (Resolve-Path 'test/fixtures/native-profile/package.json').Path
node --test test/topic-routing-eval-native.test.js
```

routing-eval 报告 1 pass / 0 skip。使用隔离原生 Host 与脚本模型，检查真实路由/决策工具请求、来源 `processingCompleted`、decision `completed`、无任务及无发送。成员说明该结果执行后共享产品文件仍继续变化，必须由整合后的源码复验。脚本模型仅验证 Host/工具合同，不证明语义质量。

### 环境准备

Lead 回报按现有 Release action 独立冻结安装 alpha2 与 rc2 profile 后，统一原生预检各 39 个模块通过，`credentialsLoaded:false`，且未改 source/lock。这是环境准备检查，不是业务回归或全套测试结果。首次仅 alpha2 的预检缺少 rc2，保留为准备过程记录，不标记为整套测试通过。

## 文档与测试映射处理

README 的当前路由合同分布在职责判断与候选目录、来源结算、Topic 默认上下文及话题聚合段落；前置决策快照要求最终同步待判/恢复、候选召回及活跃 Task 决策合同。由于实现仍在变更，本轮不将提案写成已实现，不更新 README 产品合同；待 core/recall 确认最终行为与接口后再同步，并准确区分尚未验证的边界。

测试映射按 `docs/ops/release-test-mapping.md` 执行：新测试文件必须由 `node scripts/test-suites.mjs update` 纳入完整 inventory，审阅 `test/suite-map.json` 全部差异后再运行 `node scripts/test-suites.mjs check`；`update` 不授予 history 分类资格，未知新文件保守进入 Release，不能修改 mixed 分类以绕过检查。由于成员新增测试尚未稳定，本轮未运行 update/check；整合后需由映射单写者执行并保留结果。

## 未完成与下一步

- Core 修复 8 个旧 runtime 合同失败后，提供精确工作树状态及重跑命令/结果；更新本报告应另开新轮次，不覆盖本轮历史结果。
- Recall/eval/provider 与场景资产稳定后，由 Lead 对整合源码执行定向回归及测试映射更新、差异审阅和 check。
- 独立审查、真实模型质量、部署及真实钉钉消息均未验证；本任务授权不包含付费模型、CI、部署或外发。
