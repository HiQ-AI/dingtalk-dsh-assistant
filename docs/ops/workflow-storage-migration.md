# Workflow v8 到 v9 存储切换

本流程只针对 JSON backend 的 `dingtalk_dsh_assistant.json`。迁移脚本不连接钉钉、不启动 Agent、不执行任务，不自动切换运行目录。

## 本次领域合同调整的适用边界

验收入参统一、领域阶段准备、调查 v6、通用 v6、按领域验收接纳回执、正式交付清单和失败恢复分类不改变存储 schema，不需要运行本文的 v8→v9 迁移脚本。本文的转换步骤仍仅用于原本需要从 JSON domain v8 切到 v9 的数据；各工作流版本与 JSON domain 版本不是同一套编号。

升级代码后，新调查选择 v6，已冻结的 v5 Run 继续按原定义摘要恢复。不要批量改写 workflowDigest、替换旧输入/输出，或为历史结果补写 findings、criterionReviews 和恢复分类。历史验收项按原持久记录读取，新接纳的请求才执行 1–32 条及单条 2000 字符限制。新增清单从当前成功阶段、有效验收项及现有文件登记派生，不另建迁移表。

新通用阶段选择 v6 / Owner 合同 v2，外部操作使用 Owner 合同 v2，文件投递使用 Workflow/Owner 合同 v2；各旧工厂原定义和摘要继续注册以恢复已冻结 Run。历史终态不回填 `businessValidation`；仍在执行的任务仅在完成准入时采用当前修正规则，按证据生产领域检查分派的验收项并绑定本次决定/清单。实际验收 `policyDigest` 与原 Run 冻结 `workflowDigest` 分别保留，不重跑执行或产物。不能为了完成旧任务修改其冻结定义、伪造回执或跳过检查；缺少有效业务证据时按现有等待/补料/返修路径处理。

升级回读按以下边界分别检查，不以进程健康替代业务验收：

| 对象 | 需要核对的事实 | 异常处理责任 |
| --- | --- | --- |
| 定义与交接 | 新通用 v6、外部 Owner v2、文件投递 v2 可用；各历史定义可按原摘要解析；工程只消费声明的合同类型/版本 | 实现维护方排查缺定义或不支持的版本，不改持久摘要绕过 |
| 领域业务检查 | 材料整理确定性路径及原生零工具模型检查可用；自定义 `generalCompletionCheck` 与稳定的 `generalCompletionIdentity` 同时配置 | 配置/领域维护方核对模型与检查器；未配置、超限、协议异常或证据不足均拒绝完成，不能以效果成功代替 |
| 完成与产物 | 清单结构 `complete`、当前 `businessValidation.status=accepted`、文件真实性分别可回读 | Owner 安排对应领域补证/返修；当前全部验收项仍须满足，不降级为部分成功 |
| 投递与恢复 | 外发文件/通知有实际渠道回执；未知外部效果能对应原操作 | 渠道处理投递恢复，执行层处理对账，不重新执行已确认的业务操作 |

部署后组合烟测至少覆盖“调查不足＋无关写入拒绝”和“各领域以真实证据满足自己承担的验收项后完成”。分别记录当前定义、完成状态和持久清单；本说明列出检查要求，不表示真实模型、实例或钉钉链路已经验收通过。

模型检查只接收本领域项和证据，全信封上限 128 KiB、输出上限 16 KiB / 4096 tokens、超时 30 秒；工具调用、未正常结束或 schema/逐项/引用核验失败均不接纳，不截断证据后假定通过。工程继续核对冻结原需求与实际业务用例回执，调查使用显式逐项意见。夹具可验证限额和协议分支，但真实模型语义质量仍需代表性业务样本独立评估。

实际安装与切换仍按对应实例的部署 runbook 执行：先确认运行目录、数据备份和未决外部操作，安装后独立回读包版本、进程、健康及业务状态。恢复诊断中的责任与下一步不代表允许自动重试，外部结果未知时只对账原操作。这些源码合同说明不表示已安装、部署或完成真实渠道验收。

## 切换前提

1. 停止原 Host、入站桥接及所有叶子执行，确认没有旧进程继续写入；保存源目录备份和哈希。
2. 对账所有未结 Decision、Task reservation、pending Outbox、待撤回消息及待回复人工阻塞。脚本遇到这些状态明确拒绝写目标，不能删除记录绕过。
3. 单独选择不存在的目标目录；禁止原地迁移。v6/v7 先使用原 `migrate-topic-storage.js` 到独立 v8 目录，再走本文。旧迁移使用冻结的 `storage-v8-schema.js`，不会读当前 v9 schema。

## 执行

使用当前仓库根目录，在 PowerShell 中给实际环境赋值。路径由操作者选择，以下变量不绑定个人机器：

```powershell
$sourceUnit = 'D:\storage-backup\v8\dingtalk_dsh_assistant.json'
$targetUnit = 'D:\storage-cutover\v9\dingtalk_dsh_assistant.json'
node scripts/migrate-workflow-storage.mjs --source $sourceUnit --target $targetUnit --check
```

确认 `ready:true`，再执行同一条命令去掉 `--check`。自检不会创建目标目录；执行使用独占创建，不覆盖任何已有目标。脚本通过真实 DSH DomainFacility/JsonStorageBackend 重开目标并逐表比对，再核对源字节不变；回执须为 `verified:true`、`sourceUnchanged:true`。

```powershell
node scripts/migrate-workflow-storage.mjs --source $sourceUnit --target $targetUnit
node scripts/check-resident-storage.mjs --check --source $targetUnit
Get-FileHash -Algorithm SHA256 -LiteralPath $sourceUnit
```

核对源 SHA256 与脚本 `sourceSha256`。输出只含元数据及问题类型，不输出消息正文。目标文件本身含业务数据，按原存储的访问规则保管。

## 历史与恢复规则

- 终态只有结果版本与 `task-completed` 事件一致才迁为 `succeeded`；明确且匹配本轮的取消事实才为 `cancelled`。其他为 `legacy-unknown`，不能从完成文字推断成功。
- 活动任务全部进入 `waiting/system`，附 `migrationReview:required`。输入版本递增，替换稳定新叶子会话 ID，原完整 Task 放入迁移事件保存；旧模型会话不能接着执行。
- 旧字符串只生成 `historical-unverified` 候选，不生成已核验计划或通过证据。显式恢复前人工核对授权、来源、外部结果和候选；新一轮必须重新确认结构化计划。
- 源中未知表、schema 将剥除的字段、无效记录或未结副作用会使 `ready:false`。先查明来源或完成对账，再重新生成到新目录；不能改脚本跳过校验。
- 成功目标存在时再次执行也拒绝覆盖；独立只读检查用于验证已有目标。

## 回退边界

尚未启动新 Host、没有新业务写入或外部副作用时，可以恢复原软件及完整源目录。v9 开始接收输入或执行副作用后，禁止简单还原 v8 快照：会遗失已收消息并重复外部动作。此时停写、逐项对账，优先前向修复；需回退时制定保留新增事实的专门方案。

第一次启动必须保持入站关闭，检查新版本、目标目录、阻塞任务数和旧会话未运行，再逐步放开。健康接口、迁移成功和工具回执不代替真实业务或渠道验收。
