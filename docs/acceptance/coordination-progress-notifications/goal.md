# 进度询问与协调通知全路径修复

> 状态：ACTIVE
> Goal ID：coordination-progress-notifications-20261028
> 最近维护：2026-10-28T11:29:21+08:00
> 权威目标：D:/codex/worktrees/coordination-progress-notifications/dingtalk-dsh-assistant/docs/acceptance/coordination-progress-notifications/goal.md

## 总目标
修复普通进度询问被过度解释、四个 UPR 事项协调异常，以及重复、同名混淆和矛盾的群通知。沿入站、话题、意图、任务版本、协调、执行、结算和通知追踪真实证据。

## 完成条件
- 四个指定事项和 2026-10-28 11:03:25 通知均有来源链与根因证据。
- 普通查询不修改任务、不唤醒执行、不建立持续协调；明确新要求仍可执行。
- 通知使用明确事项名称，旧观察与当前结果不混用；内部诊断改写不反复通知。
- 定向回归和必要隔离验证通过，文档及 PR 状态独立回读。

## 范围与约束
- 保留原任务、会话和效果记录，不重放已完成业务操作，不额外发群消息。
- 主检出已有修改不动；基于 origin/main@0ae6bcde 的独立 worktree。
- 已确认纯询问误建持续观察；已排除此次历史摘要递归及直接重派四任务。

## sub goal matrix
| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | 现场与全路径分析 | 四事项及重复通知完整来源链、反证和根因 | 已完成 | round-1.md、round-1-live.json |
| SG2 | 查询与协调边界修复 | 查询零业务变更，真实指令回归通过 | 已完成 | round-2.md、round-3.md |
| SG3 | 通知生成与触发修复 | 具体事项、准确状态、无无价值重复 | 已完成 | round-3.md，41项摘要测试通过 |
| SG4 | 集成验证与交付 | 定向测试、文档、PR 独立回读 | 进行中 | 302项集成及127项最终回归通过；PR待创建 |

## 当前检查点
- 当前子目标：SG4
- 唯一下一步：提交并推送已验证改动，创建PR并独立回读状态。
- 未闭环项：PR交付；正式安装和真实模型/渠道未验证。

## 进展
- 2026-10-28：主检出较旧，已 fetch 并创建最新 main 独立 worktree。最新 coordination-summary.js 有固定“原事项”和版本变化文案，但递归来源尚未证实。

- 2026-10-28：完成现场反证、源码修复、302项集成及127项最终回归；发送未成功反例先失败后修复通过，进入PR交付。

## 重大决策
- 以普通进度询问只读回答作为核心回归，不把进度问题升级为协调操作。

## 重要信息
- 四事项：修复终审只读数据UPR导入覆盖并部署UAT2；修复新建未保存草稿UPR导入受限；修复草稿UPR导入物料名称回显并部署UAT2；按v4实现合并数据集UPR替换与来源保留并提测UAT2。
- 正式 profile：D:/dsh_home/profiles/web/cordis.patch.yml；存储配置指向 D:/dsh_home/storages/dingtalk-dsh-assistant-v9-pr116；Assistant 端口 18998；当前动态账本为 D:/baibu-agent/.dsh/task-sessions.sqlite。
