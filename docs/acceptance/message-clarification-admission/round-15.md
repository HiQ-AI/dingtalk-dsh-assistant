# 登录复核及历史恢复部署

2026-10-08，用户确认指定原 profile 的 DWS 登录已显示成功，要求撤回两个错误澄清通知，并追问任务未启动。

## 登录现状与边界

插件 `/state/environment` 和终端均使用同一个 `C:/Users/64554/.local/bin/dws.exe`，原版本 v1.0.61。同一唯一账号的 lastLoginAt 更新至 10:42:29，但 CLI 显示凭据 expiresAt 仍为 10 月 6 日 03:17:09。针对 DWS 三个 DPAPI 槽只输出身份和到期元数据，均是同一旧期限，没有输出或落盘任何凭据。普通 auth status 和 event status 均返回旧认证临时授权码失效。由此排除“用户未完成登录”和“插件使用另一程序/账号”，但现有日志不足以区分新凭据未落盘和随后被旧值覆盖，不能宣称根因已完全收敛。

官方 v1.0.63 发布说明包含 Windows 鉴权文件替换遇短暂占用的修复；本机保留了 33293 个 profiles.json 临时文件，支持继续调查持久化异常，不能仅据此证明同一根因。按原生 `dws upgrade --version v1.0.63 --skip-skills --dry-run` 检查，再以相同参数 --yes 执行，官方 SHA256 校验成功；独立 version 为 v1.0.63，commit 4cd5d05393a8748e89d9265eb9f7ec85745a0331。升级后旧凭据仍不能刷新。

已发起同账号原生登录并请用户完成浏览器授权，但本次 CLI 最终返回授权超时（5 分钟）。未反复发起登录、未切账号或手写凭据。v1.0.63 的 auth status --readonly 中 authenticated=true 仅指本地记录存在且 refresh 时间未过，不证明在线刷新成功；本轮不据此声称恢复。

## 已部署的恢复能力

- Assistant SHA256 `0ffe1e166d441b88c3a707b90e5f7093ff6700fc5a7ba6b0b27c2262792bf048`，版本 1.0.0；Observer 保持 `259393aed6a274660d7b65d1badeeea1c9e1789e268e61a2312930c5669d68b6`。
- 原生部署 Check、HoldMaintenance、独立 Readback 和 Resume 通过。新 PID 108772，包回读 100 文件匹配，认证 Web 200，历史 Task/节点/Run 摘要保持。
- 最终 dispatchResumed=true、maintenanceActive=false、drained=true；消息通道仍因登录失败 degraded。
- 两条通知已精确匹配并通过现有受管入口 prepare：`recall-clarify-d48f8c-20261008`、`recall-clarify-1e3e3c-20261008`。状态仅 prepared，没有调用 execute，没有声称已撤回。
- #125 未发起直接原因：旧 coordinator 澄清 pending 且 coordinatorConsumed，commands=[]。上轮话题合并不改变历史等待。本轮仅部署“成功核验撤回后可原来源重处理”的修复，尚未执行现场 reprocess。

下一步必须先取得同账号在线认证成功证据，再逐个执行已准备的撤回并独立回读。撤回未知只 reconcile，不重发。完成后沿原来源恢复错误等待，核对唯一 Task、实际状态及新消息通道；不能伪造用户澄清答复。

本地原始日志 `docs/tmp/dws-login-investigation/`、`docs/tmp/clarification-recovery-deployment/` 与 `docs/tmp/clarification-deployment-inputs/recovery-*` 不入库。官方版本说明：<https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/tag/v1.0.63>。
