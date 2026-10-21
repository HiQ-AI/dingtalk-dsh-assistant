# AGENTS.md

本文件是本仓库的项目级工作指引。开始修改前先阅读相关源码和文档，以当前实现为准；按需查阅 `README.md` 和 `docs/ops/`，不要把历史验收记录当成当前运行状态。

## 项目与环境

- 本仓库是 DeepSeek Harness 的钉钉数字员工插件，使用 Node.js 24+、pnpm workspace；本地开发环境为 Windows 11 和 PowerShell 7。
- `packages/dingtalk-dsh-assistant/` 是消息、话题、任务与工作流的核心插件；`packages/dingtalk-dsh-observer/` 是 Web 看板；`test/` 存放测试；`scripts/` 存放构建、安装和迁移脚本。
- Agent 身份及业务工作区规则由实际配置的 Agent 工作区提供。本仓库的 `AGENTS.md` 只约束本仓库开发，不代替运行时工作区的指引。

## 修改与验证

- 优先修改现有实现，控制改动范围；行为、配置或接口发生变化时，同步更新相应文档。
- 安装依赖使用 `pnpm install --frozen-lockfile`。执行命令使用 PowerShell 7 语法。
- 测试用例较多，默认只运行与本次修改功能直接相关的测试，不主动运行全量测试。例如：`node --test test/<相关文件>.test.js`。大改必须运行风险相关测试；本地发布准备默认相关回归与 `pnpm test:release-smoke`，不再重复前置全量。`pnpm test:all` 与手动扩展 CI 用于明确要求或风险所需的全覆盖。正式发行精确 SHA 由一次 Release CI 权威验证全部 release=true 映射分组，失败不能跳过。
- 已逐注册审定的纯历史流程保留 `pnpm test:history` 与手动 CI history 入口；修改相关旧源码或共享夹具须显式验证相关历史路径。当前/保留兼容合同及未知覆盖仍进入 Release；分类、守恒及范围见 `docs/ops/release-test-mapping.md`。不能只更新映射或摘要跳过未复审变化。
- 代码变更至少实跑相关测试或功能路径，报告实际结果；不要把测试通过等同于本地部署或真实钉钉消息验证通过。
- 普通开发/修复分支的提交、推送及创建/更新 PR 不得触发 CI，包括不得主动使用 `workflow_dispatch`、`gh workflow run` 或其他入口补跑。
- 仅在用户明确要求运行 CI 时，才可主动触发、重跑或补跑 CI；提交、合并或部署请求不包含手动运行 CI 的授权。
- 保留版本 Tag 的强制发行检查：完整测试映射不遗漏文件；验证、构建与发布分离；发布只使用同 run/精确 SHA 已验证三包及摘要清单。不可删除失败断言、按文件名退出历史覆盖或绕过失败分组。仅发布 job 失败时复用原 run 产物重试，不重复测试或跨 SHA/lock/profile/工具环境缓存通过结论。若缺少 CI 授权而交付所需检查尚未满足，报告冲突，不自行触发或跳过检查。
- 部署和迁移先读 `docs/ops/` 中对应 runbook，执行前确认运行实例、持久化数据和回退边界；不要凭记忆拼接操作命令。
- 本地部署时不需要备份历史副本。

## 交付

- 保留工作区已有的未提交文件；提交或交付前核对 `git status` 与实际 diff。
- 涉及 PR 时，说明改动、相关测试及未验证边界，并独立回读 PR 状态；涉及本地部署时，再独立回读安装包、进程和健康状态。
