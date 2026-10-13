# 执行会话唯一责任闭环

> 状态：ACTIVE
> Goal ID：owner-capability-responsibility
> 最近维护：2026-10-13T16:02:38.8078980+08:00
> 权威目标：D:\codex\worktrees\remove-task-sheet-sync\dingtalk-dsh-assistant/docs/acceptance/owner-capability-responsibility/goal.md

## 总目标

原持久任务执行会话能够自己诊断和解决可解决的能力/验证缺口，完成工具执行、纠错、验收和最终回复。维护会话不替它完成业务。原双专家撤回核验任务用于现场验收。

## 完成条件

- 原Owner自行交付且结果有受信业务证据；基础设施变更经定向测试、PR和部署回读。

## 范围与约束

- 不代做UAT业务，不强停运行Owner；使用原任务和正式维护入口。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | 核实现有工具与责任断点 | 读实现、提出可复用最小路径和反例 | 完成 | round-1.md至round-10.md |
| SG2 | 实现执行会话自主推进 | 实际执行能力、身份及控制约束覆盖 | 完成 | round-1.md至round-10.md |
| SG3 | 定向验证与独立审查 | 自主纠错及越权/未知效果反例通过 | 完成 | round-1.md至round-10.md |
| SG4 | 本地部署与原任务实证 | 原会话自己执行并完成交付，无代做回执 | 进行中 | round-1.md至round-10.md |
| SG5 | Git/PR交付 | 实跑证据、远端状态独立回读 | PR 168 已创建 | round-1.md至round-10.md |
| SG6 | 整轮上下文去重 | 无独立回执通知、基线可恢复、SDK回归通过 | 已部署，80项通过 | round-1.md至round-10.md |

## 当前检查点

- 当前子目标：SG6
- 唯一下一步：由原Owner继续完成业务交付；本轮本地部署及原生结果引用已核验。
- 未闭环项：原UAT业务交付；积压事件导致恢复首轮输入仍较大。


用户最新“执行会话不禁止任何工具”已实现并部署；现场 43 个工具真实可见，原会话已自行成功调用 PowerShell 与 todo_write，证据绑定当前 Task/需求/会话/租约。维护侧的工具开放工作完成；SG4 原业务交付由唯一负责的原会话继续执行，尚不声称 UAT 结论或群回复完成。见 round-4.md。

## 进展

- 2026-10-13：停止维护会话业务代做；此前隔离 UAT 副本已清理。既有结果仅供故障分析，不能充当本轮自主执行验收。
- 基线 origin/main=7862e2b，分支 worktree-owner-capability-responsibility，复用已附属 worktree；主检出未修改。
- 相关旧 task-execution-responsibility 已完成的是失败节点恢复，不包含未建阶段时的能力缺口，故本轮独立归档。
- 原生调用是执行来源证据，不自动代表业务成功。取消或只有 started 的调用保留未知状态，须回查效果；不能以命令打印 PASS 代替独立业务结果。无控制库 schema 或冻结工作流变更。
- 用户随后明确“执行会话不禁止任何工具”：移除本次加入的名称白名单、类型禁用及后台禁令。完整宿主工具可用，仍保留任务暂停/取消、身份核验、宿主权限与审批；Owner 对委派和后台作业的结果持续负责。前两轮测试中的禁止工具断言是历史结果，不代表最终要求。
- 用户进一步明确执行会话必须完全权限：新建和恢复在模型请求前设置并核验 danger-full-access / never；覆盖原会话 workspace-write / ask，不仅开放工具。定向测试 65/65 PASS，原会话原生权限实时切换并独立日志回读通过（round-5）；自动设置源码已随round-6部署，原会话恢复后仍为完全权限。
- Round 6：原 Owner 被 TASK_OWNER_CORRECTION_LIMIT 阻断。现场候选 condition.evidenceRefs 未包含于主 evidenceRefs；笼统反馈无法定位字段，四次提交仍未修正。保留校验和纠错限额，补精确反馈并验证同会话纠正，再部署恢复原 Task；不代做 UAT 业务。

- Round 6完成基础设施修复、定向测试与部署；原Owner已正式恢复running，last_failure清空，43工具可见。原业务仍由同一Owner继续交付。
- Round 7：原Owner合法capability block仍外包验证准备。新增技术停止依据核验，仅反馈判断不接管任务；原会话自行准备、执行和交付。见docs/spec/owner-stop-reason-validation.md。
- Round 8：压缩每轮重复的完整证据索引和流程目录；真实输入14737→6190、17314→6922字符，74项相关测试通过；本地切换须先排空原会话，不修改历史日志。
- Round 9：同轮来源正文精确去重，用户样本6190→5839字符；75项定向测试通过，源正文可精确还原。尚未部署，不宣称达到3000字符。
- Round 10实现完成：移除独立工具回执通知、系统承载固定规则、当前可见基础信息单份复用；基线丢失从Host重建，见docs/spec/owner-context-round-dedup.md。

- Round 10：80项定向测试通过；新注入2102字符、单份基础信息3494字符，系统说明另计，不夸大整体输入降幅；源码独立审查无阻断。部署仍需排空。

## 重大决策

- 基线仍计入总输入，不以拆分字段冒充token节省；原Owner持续负责业务。

## 重要信息

- PR 168用于当前基础设施变更；round-10记录80项测试及投影尺寸。
- Round 11进行中：用户要求本地部署；已从堆内存耗尽退出恢复旧服务并进入正式维护，等待原Owner收口后安装候选13d64bc。

- Round 11：SHA256 a304c582f21c2c50cdc215ea1c0f2f7be6c792e4bc4e35cc59fc6521f9f75c3d已安装，进程42884，health=ok，维护revision767 inactive。原Task正式resume controlRevision3；基线3494字符，恢复首轮16923字符其中events15556，不能套用静态样本2102。
