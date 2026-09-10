# 常驻通知修复本地部署

本 runbook 用于未发布修复包在现有 Windows DSH `web` profile 的安装与验证，不升级 DSH、模型、OAuth、代理或其它插件。沿用[源码开发安装说明](../manual/install-and-configure-dsh-web.md)的原生插件安装路径。组织权限由负责人处理，本轮不重新登录、不主动重试或补发真实群消息。

## 安装前自检

1. 跑本轮回归和 `node scripts/build-web-client.mjs`，确认生成文件与源码一致。
2. 读取 `%USERPROFILE%/.dsh/profiles/web/package.json`，保存 Assistant/Observer 两个依赖的原值用于回退；对 profile patch 和任务流程配置计算摘要，不记录凭据或消息正文。
   本次协调修复还需对确认过的 `dingtalk_dsh_assistant` v7 JSON 文件做只读预检。先在脱敏副本验证，也可直接读取原文件；脚本不会打开 Domain 写入接口，不改原文件，不输出正文、记录 ID、凭据或源路径：

```powershell
node scripts/check-resident-storage.mjs --check --source '<已确认的v7存储文件或副本绝对路径>'
```

   必须退出码为 0 且 `ok: true`；输出各表数量、扩展字段数量、校验错误代码计数及 `strippedFields`。`strippedFields > 0` 表示当前 Schema 会丢字段，不能忽略后继续切换。运行中存储可能变化；停止已核实的实例、排空写入后，先把完整存储备份到仓库外受保护目录并记录 SHA256，再对稳定原文件重跑预检。备份包含业务消息和授权内容，禁止提交 Git。脚本只验证当前 Schema 可读且不剥离已有字段，不替代 Topic 引用和业务完成证据验收。
3. 确认 `%USERPROFILE%/.dsh/profiles/web/node_modules/@deepseek-ai/dsh/lib/bin.js` 存在。本机全局 `dsh.ps1` 曾指向已删除目录；本 runbook 固定使用 profile 内的原生 CLI，不依赖全局 shim。查询 3080、18998 listener，确认同属当前 DSH Web 进程，记录 PID。检查进程与端口后才能停止该实例，不结束其他 Node/DWS 进程。
4. 在 `docs/tmp/` 下创建本次唯一打包目录（包含本轮提交标识），按实际修改打包内部包。本次协调修复只修改 Assistant，Observer 保持原依赖；同时修改两个包的任务才执行两条命令：

```powershell
pnpm --dir packages/dingtalk-dsh-assistant pack --pack-destination ../../docs/tmp/<unique-directory>
pnpm --dir packages/dingtalk-dsh-observer pack --pack-destination ../../docs/tmp/<unique-directory>
```

独立回读两个 tgz 文件大小和 SHA256。不得覆盖此前同路径同名包后依赖缓存刷新。

## 安装与启动

1. 停止已核实的 DSH Web PID 及仅属于该进程的 DWS 监听子进程，避免遗留重复监听；将新 tgz 绝对路径传给 profile 内的原生 CLI：`node "$env:USERPROFILE/.dsh/profiles/web/node_modules/@deepseek-ai/dsh/lib/bin.js" plugin --profile web add <assistant.tgz> <observer.tgz>`。
2. 回读 profile 的两个依赖，逐一比较安装目录与工作区修改文件的 SHA256，确认原有 profile patch 未变。
3. 按现有 `scripts/start-web.ps1` 启动；后台 PowerShell 进程使用 `Start-Process -WindowStyle Hidden`。stdout/stderr 只存本地 `docs/tmp/`，日志可能含登录链接，不进入 Git。
4. 启动地址在 loader 完成后才输出，端口出现不代表地址已可读取；先确认日志包含地址再做认证访问，不把空日志当作启动失败。确认两个端口属于新进程，检查 `/health`、`/state/agent-config` 与 Web 认证访问。配置摘要应保持一致；health 的组织权限错误需单独说明，不能将其写成插件测试失败或真实投递通过。

## 验收与回退

源码测试、安装包一致性、启动、认证访问、看板合成数据验证分别留证。真实 DWS 投递保持未验证，不改 pending 状态来使看板变绿。

本次协调修复保持 Domain 版本 **7**，通过可选字段和默认值读取旧记录：Task 的 `activityProjection`、`stagePlan`，Group 的 `coordinationRequests`，活动的 `seq`，以及 `executionEvents` 内报告接收、审阅、处理、通知状态。旧字段和历史检查点保持可读，不运行 v6→v7 全库迁移。首次恢复活跃旧任务时，从其已批准计划补齐阶段索引，记录 `stage-plan-reconciled` 与旧阶段数组；不更改原检查点、审批、inputVersion 或结果。没有已批准计划不补造阶段。`--check` 只验证读取兼容性与字段保留，启动规范化由两次重启幂等测试单独覆盖。

**不能仅换回旧二进制并继续写原存储。** 旧 Schema 可能在更新 Task/Group 时剥离这些新字段，造成通知恢复、水位或审阅状态丢失。曾写入新状态后，应先停止写入，保留当前完整文件和安装前备份；优先前向修复。确需降级时，先在隔离副本证明目标版本不会丢新字段、不会重放外部动作，再允许恢复写入；未证明之前保持停机或只读查看，不启动旧版可写实例。

不得直接恢复安装前快照覆盖切换后新产生的审批、通知或外部动作记录。回退包本身仍走原生插件安装并独立核对依赖和文件摘要，但包回退不等于存储已安全回退。若新旧存储不能无损转换，保留现态完成前向修复。
