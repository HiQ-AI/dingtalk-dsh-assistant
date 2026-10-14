# 显式项目验收配置迁移

`scripts/configure-project-local-acceptance.mjs` 是源代码仓库中的离线配置维护工具。它不注册工作流、不创建运行任务，也不会执行验收命令或访问业务服务。旧业务流程的历史文档不能当作当前插件运行入口。

## 项目范围

- `--bundle` 指向 JSON 对象，键是要修改的仓库配置 `id`，值是完整的 `localAcceptance` 配置。必须显式列出至少一个项目；没有预置项目名，也不要求固定项目数量。
- 每个项目必须在 profile 的同一 `repositories` 集合中唯一存在，并有合法的绝对 `managedRoot`。未列出的项目保持原样。
- 配置仍按现有 runner 结构验证。工具只维护配置，不代表业务验收已通过。

## 可选策略与维护边界

- `--merge-policy` 的目标必须已在 profile 的 `platforms.release.targets` 中唯一配置为 `uat-deployment`，并明确提供 repository 和 branch。
- 目标 repository 必须与一个已选择项目的显式 `githubRepository` 精确匹配；不会通过项目名、远程地址或分支名猜测绑定。
- `requiredScenarioIds` 必须属于该项目 bundle 中的场景。既有其他目标策略保留，不会被一次局部更新删除。
- `--repository-patches` 只允许明确选择项目的 `dependencyRepositories` 和 `taskLocalAcceptance`。依赖必须是本次选择的其他项目，不能自依赖或重复。
- 旧的项目专项 `--checks-proposal` 已关闭，返回 `LOCAL_CONFIG_LEGACY_CHECKS_PROPOSAL_UNSUPPORTED`；repository patch 也不再允许改写顶层 `checks`。这些历史私有迁移规则没有被扩展为任意命令改写能力。
- `--restore-proposal` 从明确的 proposal 仓库列表确定恢复范围，继续要求来源 profile、部署回执、活动运行定义以及摘要全部一致。

## 验证与写入

先运行 `--check` 查看零写计划。`--apply` 必须提供当前 profile 的 `--expected-sha256`；工具持有配置锁后再次比较原文，再原子替换和独立读回。重复应用相同配置不写文件。

本工具仍保留原有恢复证据机制。它不修改新运行时的插件接入、skills 或 Agent 工作区设置。历史业务脚本、历史验收记录和实际用户 profile 不在本次通用化迁移范围内。
