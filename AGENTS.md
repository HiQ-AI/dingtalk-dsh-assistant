# AGENTS.md

本文件是本仓库的项目级工作指引。开始修改前先阅读相关源码和文档，以当前实现为准；按需查阅 `README.md` 和 `docs/ops/`，不要把历史验收记录当成当前运行状态。

## 项目与环境

- 本仓库是 DeepSeek Harness 的钉钉数字员工插件，使用 Node.js 24+、pnpm workspace；本地开发环境为 Windows 11 和 PowerShell 7。
- `packages/dingtalk-dsh-assistant/` 是消息、话题、任务与工作流的核心插件；`packages/dingtalk-dsh-observer/` 是 Web 看板；`test/` 存放测试；`scripts/` 存放构建、安装和迁移脚本。
- Agent 身份及业务工作区规则由实际配置的 Agent 工作区提供。本仓库的 `AGENTS.md` 只约束本仓库开发，不代替运行时工作区的指引。

## 修改与验证

- 优先修改现有实现，控制改动范围；行为、配置或接口发生变化时，同步更新相应文档。
- 安装依赖使用 `pnpm install --frozen-lockfile`。执行命令使用 PowerShell 7 语法。
- 测试用例较多，默认只运行与本次修改功能直接相关的测试，不主动运行全量测试。例如：`node --test test/<相关文件>.test.js`。用户明确要求、项目强制检查或定向测试无法覆盖关键风险时，再运行全量测试（`pnpm test`）。
- 代码变更至少实跑相关测试或功能路径，报告实际结果；不要把测试通过等同于本地部署或真实钉钉消息验证通过。
- 部署和迁移先读 `docs/ops/` 中对应 runbook，执行前确认运行实例、持久化数据和回退边界；不要凭记忆拼接操作命令。

## 交付

- 保留工作区已有的未提交文件；提交或交付前核对 `git status` 与实际 diff。
- 涉及 PR 时，说明改动、相关测试及未验证边界，并独立回读 PR 状态；涉及本地部署时，再独立回读安装包、进程和健康状态。
