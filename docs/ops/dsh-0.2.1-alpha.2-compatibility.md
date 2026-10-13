# DSH 0.2.1-alpha.2 兼容说明

## 版本边界

本分支按用户明确选择适配 `0.2.1-alpha.2`，不是稳定版承诺。2026-10-13 核验时，官方 npm 的 `latest` / `next` 是 `0.2.0-rc.2`，`alpha` 是 `0.2.1-alpha.2`；所有已发布版本均含预发布后缀，GitHub 没有非预发布的 latest release。

- [官方目标 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.2)
- [npm 官方 dist-tags](https://registry.npmjs.org/-/package/@deepseek-ai/dsh/dist-tags)
- 目标源码 commit：`d743267388641bc76f17c45ce8b4c231aed1d32c`
- 插件改动基线：`e8e103e9c6b9e4fc150f1c8870cf428e65d77e92`

根开发依赖、Assistant/Observer 和 profile 的 DSH 版本统一固定。Cordis / Loader 使用目标发布中的 `4.0.5-alpha.1` / `1.0.6-alpha.1`。删除已退役的 code-runtime、invariants 依赖，按新包名引用 preset registry 与本进程 subagent provider。不得保留旧版 service peer（例如 session-persistence、session-projection）；它们会导致具名导出缺失或服务 API 不一致。

开发安装：`pnpm install --frozen-lockfile`，Node 24+，pnpm 10.13.1。安装后回读 lockfile，不以顶层版本正确代替整棵依赖树一致。

## 适配内容

- 持久日志使用 `open(id, 'read')` 的只读句柄，成功和异常路径均关闭，不争抢在线 Agent 的写所有权。
- 使用公开 Inbox 队列判断待处理输入，使用显式 setup Agent 参数，关闭时等待 `subagents.drainDescendants`。
- 读取 V4 `role: tool` 回执及 `toolCallId`，保留来源事件、调用身份、失败状态与实际文件哈希核验。
- 插件身份事件采用 `plugin:dingtalk/...`；历史迁移后的身份仍按原业务字段、会话、租约严格核验。
- 派生会话保留原事件前缀及继承切点，追加原生 `session/end-seed` 标记；不原地改写历史证据。
- Surface 替换使用 `startSeq/endSeq`，初始用户基线经 Inbox 在系统头之后进入当前轮；工具回执压缩留在原生 step 内。
- Observer 使用 `main.conversation`，会话导航改用 `uiWorkspace.openSession`，子会话目录使用 `sessions.refreshProjections`。

## 历史数据与部署限制

目标宿主使用 Session V4。官方格式迁移保留旧文件，并在写入时发布新格式文件；这不意味着旧版本能理解升级后的会话或新增事件。不要在已经继续运行的新数据上直接降级宿主。插件业务控制账和冻结工作流不做批量改写，不迁移现场数据库，不重做 workflow/Skill 架构。

[官方 V3→V4 说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.2/packages/session/session-format-v3-to-v4/README.md)

本次工作在 dot 的独立云工作区完成，没有部署到用户电脑或发起真实钉钉消息。部署仍须遵循 [resident 维护部署流程](resident-review-local-deployment.md)，先核对实际 profile、模型 provider、维护排空、会话迁移和回退边界。可选 `dsh-codex-connect` 是独立第三方 provider，其真实账号登录及模型服务须在部署验收时单独回读。

## 默认 registry profile 与本地组合包

仓库 resident profile 仍固定 `dsh-codex-connect@0.1.0-alpha.4.30`（Web profile 是 `0.1.0-alpha.4.18`）。它们声明旧 DSH peer 边界，不能因为钉钉插件测试通过而视为可用。2026-10-13 核验的第三方最新 `0.2.0-alpha.3` 也只声明支持至 `0.2.1-alpha.1`，没有覆盖本次目标。

实际执行 alpha2 CLI 的 `--profile resident --dump-config` 时，CLI 虽然退出码为 0，但明确输出 `skipping profile bundle "dsh-codex-connect"` 和不兼容警告；因此该 profile 不能声明启动验收通过，配置的 `openai-codex` 模型链路仍未验证。仓库保留这些 registry pin，不把尚未发布的本地修改伪装成 registry 版本，也不执行 `dsh plugin allow-version` 豁免。

本次另行交付 `dsh-alpha2-suite` 本地组合包，包含三份核心 npm 包、适配后的 Codex provider、仍需保留的 convergent 压缩插件、相对路径 resident/Web profile、来源提交、许可证、补丁和 SHA256。以组合包中文说明执行隔离安装，不直接覆盖现有 profile。修订 provider 的真实 alpha2 API 注册、11 个模型的 prepareCall 及释放已通过（禁用网络、无真实凭据）；组合 resident 的 stock CLI 配置加载也已通过。真实登录、模型调用、Windows resident 和钉钉端到端仍待部署验收。

## 验证记录

回归覆盖真实原生 Loop/JSONL、跨进程恢复、V3 文件迁移及原文件保留、Owner/执行/群会话、证据归属与拒绝路径、Observer slot 恢复和导航。测试使用脚本模型，不代表真实模型、钉钉投递或现场部署通过。

云工作区是 Linux，未提供 PowerShell/真实 Windows 验收工具链。包含 Windows 本地部署、工程构建和平台验收的全量测试必须分别报告；不能删除平台安全检查或将这些未验证路径标作通过。最终命令、数量与平台限制记录于 PR。

2026-10-13 Linux 最终全量：3401 项，3275 通过、93 失败、33 跳过、0 取消。与基线提交及其原始依赖的独立全量比较，新增失败为 0；93 项失败均在基线存在，9 项原基线失败已消除。原生/兼容集中回归 555/555，Loader 卸载与回执专项 6/6。未修改冻结 workflow 期望哈希或 Windows 安全检查来消除基线失败。
