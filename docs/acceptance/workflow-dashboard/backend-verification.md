# 托管配置后端核验补充

日期：2026-10-13。工作目录为 `D:/codex/worktrees/workflow-dashboard/dingtalk-dsh-assistant`。本文件补充后端与启动链证据；浏览器状态仍以本目录 matrix 和各 round 为准。

## 实跑结果

| 命令 | 实际结果 |
| --- | --- |
| `pnpm install --lockfile-only`、`pnpm install --frozen-lockfile` | 成功；正式 credentials / credentials-local 固定为 0.1.2-rc.1 |
| `node --test test/workflow-configuration.test.js test/http.test.js test/client.test.js test/execution-configuration.test.js` | 实例隔离修复后 67/67 PASS，0 FAIL，0 SKIP |
| `node --test test/dingtalk-dsh-assistant.test.js test/workflow-entry.test.js test/external-registry-startup.test.js test/runtime-startup-observation.test.js` | 23/23 PASS，0 FAIL，0 SKIP |
| `node --test --test-name-pattern '配置HTTP' test/http.test.js` | 审查补充拒绝 GET 非空 body 后 3/3 PASS |
| `node --test --test-name-pattern '单一业务插件' test/dingtalk-dsh-assistant.test.js` | 实例隔离修复后，无 workflow / credentials 的旧启动用例 1/1 PASS |
| `node scripts/build-web-client.mjs` | 设置页生成成功；重复生成 SHA256 一致（DB3C766058DBE191FFFE699EA13D6E0AFDCAC3FFE6D056BF903DA765D472EFD8） |
| `git diff --check` | 通过；pnpm-lock 的 LF/CRLF 提示不代表内容错误 |

`workflow-configuration.test.js` 的 12 项测试包括：普通 JSON 和秘密分路读取、秘密无 value/versions 投影、配置文档原子 CAS、旧 Run 固定版本、停用只阻止新绑定/快照、工程派生同目录保留初始快照、跨流程同 runId 拒绝、旧 Run 缺快照不隐式补新值、类型/格式不可变、输入/历史损坏拒绝、64 KiB/100 变量/4 MiB 上限。

原生持久化独立于 Map 替身验证：使用正式 `LocalCredentialProvider` 在 `docs/tmp/workflow-configuration-tests/` 的随机隔离路径导入测试普通值与测试秘密，移动来源文件，释放原生 Context，再创建新 Context；旧 Run 仍读旧秘密，新 Run 读轮换后的值。另用两个原生 Context 同时写同一隔离凭据文件，真实文件锁内 CAS 恰有一个成功；第三 Context 读回文档 revision=1、变量数量=1。

完整 Resident 用例使用正式 `cutoverWorkflow` 产生隔离 SQLite 控制库及封存记录，再启动 `applyResident` 的真实 workflow service。通过 HTTP 回读 `engine=workflow-v2` 和目标群，保存变量后独立读取原生 credential record；关闭 Resident 和凭据 Context，重建两者后 HTTP 仍读回值。旧域仅用独立表替身，原生凭据、控制库、封存核验、HTTP 和 workflow service 均真实运行；DWS 明确关闭，写授权为 false，任何模型会话调用均拒绝。

HTTP 核验包括完整 GET/PUT/enabled/binding 路径、服务端身份、严格请求 schema、GET 非空 body/自报身份拒绝、真实 Host 与 Origin 拒绝、非回环拒绝、409 CAS、固定错误码和 `Cache-Control: no-store`。Host 用 Node 原生 HTTP 请求发送，避免 fetch 重写 Host 造成假验证。`execution-configuration.test.js` 另实跑执行控制器、原生存储、Host 重建、冻结读和 DB connector 替身；取消后保存的读取器失效，未接配置服务的普通执行保持可运行，实际读配置失败关闭。

## 独立审查

只读检查了 `ConfigurationBrowser`、`WorkflowConfigurationBindings`、配置模块与 HTTP。dirty 草稿切页不主动刷新文档 revision，GET 通过取消和 current 标记隔离过期响应；秘密编辑从空输入开始，保存后用脱敏 state 重建空输入。后端快照在受信 instanceId 命名空间内只取 runId hash，验证初始流程和目录归一身份；管理错误不传播 provider 文本。

主代理进一步发现共享原生文件的跨实例碰撞风险。独立核对正式 provider 的 `resolveSpec` 确实默认使用 `$DSH_HOME/.credentials.yaml`，没有 profile 维度。已在配置文档和 Run 快照地址加入 instanceId SHA256 命名空间，并复核 payload 的 instanceId；无旧全局 key 回退。新增正式 native provider 用例让两个实例共享同一文件、同名变量和相同 runId，分别读取自己的冻结秘密；管理 actor 不能跨服务冒用。同一实例内仍不能借换流程重冻结。

发现并已反馈主代理的 UI 竞态：保存 A 在途时，从工作流页打开 B 的配置，target effect 会先把 B 标为已消费，再因 busy 忽略导航；A 的保存回执可能重新选中 A。主代理已修复，独立回读 [round-13](round-13.md) 的 16 项浏览器结果记录：新增持有保存响应、切页选 B、释放响应后最终落 B 的用例通过，秘密仍不回显。本代理未重复操作浏览器。

交叉审查工程消费链时发现端口类型校验会将 `true` 转为端口 1；通过真实 connector 加无网络 Client 替身复现 `opened=1, receivedPort=1`。集成代理修复为只接受整数数值或纯数字字符串后，用同一最小 probe 回读为 `opened=0, error=QUERY_DATABASE_CONFIG_INVALID`。同时推动收窄新工程工具的范围，仅显式托管映射且原 permissions 授权的数据库进入节点目录；scope 重算从真实 Run/节点/Session/定义取得依据，消息及 Owner 保留原分支。完整工程 v26 与历史摘要回归由集成验收记录提供。

## 主线合并后联合回归

合并 `origin/main` 的表格同步移除、看板页面保持与任务详情关联、工程合同发行字节改动后，保留上述合并前证据，另实跑以下最终联合组：

```powershell
node --test test/workflow-configuration.test.js test/http.test.js test/client.test.js test/observer-client.test.js test/observer-node-control-display.test.js test/dingtalk-dsh-assistant.test.js test/workflow-entry.test.js test/external-registry-startup.test.js test/runtime-startup-observation.test.js test/engineering-approach-contract.test.js
```

2026-10-13 04:39:14 UTC 开始，实际结果 **133/133 PASS，exit 0，FAIL/SKIP/CANCELLED 均为 0**，耗时 7688.7501 ms。覆盖移除表格同步后的完整概览、旧路由 404、配置权限与原生持久化、实际 Resident 启动，以及 `core.autocrlf=true/false` 两种真实 Git checkout 的合同发行字节。完整日志仅保存在 `docs/tmp/workflow-dashboard/final-joint-after-main.log`；命令、计数与七个关键源码 SHA256 见 [结构化汇总](backend-final-summary.json)，测试前后这些源码均无变化。

合并后的 Assistant 设置页已重新生成，bundle SHA256 为 `ec26774f7406eb20420d0003e3cac3b8bdc34f5030d9d8d3310ff0b777fd685d`；Observer 为 `80aa9905cdffafde417b800f87568748902c16932d62dd3dd592f50b5d7f13f4`。前文 DB3C7660 开头的生成摘要仅代表合并前版本。

最终只读审查发现重置直接创建 Run 会绕过配置快照，已由集成代理修复：`resetTaskExecution` 先检查回执与完整 reset 准入，再冻结新 Run 并提交；预览和重复回执不会重新冻结。独立读回原生消费用例及日志，确认实际 reset/dryRun/replay/resume 路径通过；首次组合为 11/12（原生用例通过，单个测试清理夹具缺少 close），修正夹具后的 reset/connector 组合为 18/18 PASS。该组由集成代理实跑，本代理只读核对，日志分别为 `docs/tmp/workflow-dashboard/runtime-reset-configuration-round1.log` 与 `runtime-reset-connector-round2.log`；不将其并入本代理的 133 项统计。

## 边界

以上不是正式部署或真实钉钉消息/真实数据库业务验证。未读写正式凭据，未自动迁移原有配置文件；临时目录只有测试合成数据，不纳入提交。默认 credentials-local 明文持久化的事实已用隔离文件验证并写入 README/部署说明；Web 脱敏不代表磁盘加密。
