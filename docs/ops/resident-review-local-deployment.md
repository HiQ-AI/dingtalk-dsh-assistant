# 常驻通知修复本地部署

本 runbook 用于未发布修复包在现有 Windows DSH `web` profile 的安装与验证，不升级 DSH、模型、OAuth、代理或其它插件。沿用[源码开发安装说明](../manual/install-and-configure-dsh-web.md)的原生插件安装路径。组织权限由负责人处理，本轮不重新登录、不主动重试或补发真实群消息。

## 安装前自检

1. 跑本轮回归和 `node scripts/build-web-client.mjs`，确认生成文件与源码一致。
2. 读取 `%USERPROFILE%/.dsh/profiles/web/package.json`，保存 Assistant/Observer 两个依赖的原值用于回退；对 profile patch 和任务流程配置计算摘要，不记录凭据或消息正文。
3. 查询 3080、18998 listener，确认同属当前 DSH Web 进程，记录 PID。检查进程与端口后才能停止该实例，不结束其他 Node/DWS 进程。
4. 在 `docs/tmp/` 下创建本次唯一打包目录（包含本轮提交标识），分别打包两个修改的内部包：

```powershell
pnpm --dir packages/dingtalk-dsh-assistant pack --pack-destination ../../docs/tmp/<unique-directory>
pnpm --dir packages/dingtalk-dsh-observer pack --pack-destination ../../docs/tmp/<unique-directory>
```

独立回读两个 tgz 文件大小和 SHA256。不得覆盖此前同路径同名包后依赖缓存刷新。

## 安装与启动

1. 停止已核实的 DSH Web PID；将新 tgz 绝对路径作为参数传给 `dsh plugin --profile web add <assistant.tgz> <observer.tgz>`。
2. 回读 profile 的两个依赖，逐一比较安装目录与工作区修改文件的 SHA256，确认原有 profile patch 未变。
3. 按现有 `scripts/start-web.ps1` 启动；后台 PowerShell 进程使用 `Start-Process -WindowStyle Hidden`。stdout/stderr 只存本地 `docs/tmp/`，日志可能含登录链接，不进入 Git。
4. 确认两个端口属于新进程，检查 `/health`、`/state/agent-config` 与 Web 认证访问。配置摘要应保持一致；health 的组织权限错误需单独说明，不能将其写成插件测试失败或真实投递通过。

## 验收与回退

源码测试、安装包一致性、启动、认证访问、看板合成数据验证分别留证。真实 DWS 投递保持未验证，不改 pending 状态来使看板变绿。

回退时停止本次 DSH Web，使用安装前记录的包依赖重新执行原生插件安装，确认源码摘要与目标版本后启动。此修复未修改存储 schema 或原始任务流程配置，无须迁移业务数据。
