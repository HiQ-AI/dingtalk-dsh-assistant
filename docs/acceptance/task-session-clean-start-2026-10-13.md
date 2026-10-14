# Clean-start 与 Web 构建增量验收

## 基线与交付范围

原交付提交 `9eb937cddf8100a2eed1ca4e2925e7d659e6db16`。Web 构建修复为 `e1fffa7fc098ff14fb7c63747f3b8d44f66e31ff`。2026-10-13 实际 fetch 核对最新 main `15630d615ff01f651271b581fe23031a4e89e86a`（PR170），本地整合后生产源码冻结在 `568e5ae56feb21d2a1fd049102a057839a887cfe`，树 `a497c31844af5366314b7fbbac1f08fa16e2c61e`。没有推送、远端合并或部署。

采用用户最新选择：全新任务库及 Resident domain，不兼容旧任务。主程序不导入旧152项阻塞、不读取旧任务详情/授权/通知。旧 history helper 仍是离线库，不接 active runtime；旧文件及证据不删除。旧迁移 runbook 已标为历史方案，实际步骤见 `docs/ops/task-session-clean-start.md`。

PR170 的宿主联合升级/worker/登录跳转资料按原提交完整保留；它们不授权执行旧任务迁移。Observer 改为官方 Regular 图标；Assistant 保留已验证本地刷新组件，构建器不再注入同名声明。实际构建、语法检查、重复构建字节一致及官方 ClientModuleRegistry → fetchBundle → 官方 browser module system 导入均通过。

## 新增实际发现及修复

- 真实 resident HTTP 创建任务后，原生日志隔离子 scope 命中了强 inject 缓存的中央 router，导致 open 递归；改为显式解析独立 backend 并验证 identity。真实 resident 新任务现已完成 session 绑定、脚本模型请求、决定落盘与排空。
- 新账本把 ingressEpoch 绑定 SQLite meta 和初始化标记，重启改变/省略或旧无 epoch 库补绑均拒绝；未知效果与已有状态不被改写。
- DWS 真实时间缺失显式保留 null，不能以展示用 now 放行。严格合法日历/ISO/毫秒解析，只有完整无时区 DWS datetime 按 +08:00。日期-only、短时间、非法日期滚动均隔离。
- ready 历史回补在下载/旧去重前进入新门禁。旧与缺时间消息仅存幂等负收据，零模型/材料/任务。边界后新消息正常，重复及重启幂等。
- 自发回声按真实 assistantActorId 或本群持久通知回执 messageId 忽略，不按正文/昵称判断。未配置 assistantActorId 且回声先于回执落盘是明确边界。

## 冻结验收

在 `568e5ae` 实跑以下16套，187/187通过、0失败、0跳过；实际构建及 `node --check` 另通过，生成物与Git完全一致：

`task-session-clean-start`, `task-clean-ingress-native`, `task-ingress-epoch`, `task-session-persistence-native`, `task-session-service-native`, `task-session-http-integration`, `task-session-material-history`, `dynamic-task-store`, `web-client-build`, `client`, `observer-client`, `dws-bridge`, `dynamic-execution-session-native`, `task-filesystem-boundary-native`, `task-native-unknown-fence` 与 `dingtalk-dsh-assistant` 的 `test/*.test.js`。

包含真实 DSH/Cordis/SQLite/JSONL/FS/子进程、跨进程异常退出、原生取消/并行、unknown fence、HTTP 路径；模型仍为脚本模型，DWS 为受控传输。不是钉钉在线/Windows视觉验收。

独立审查实证的日期绕过及 persistence 递归均已用原反例关闭；其 clean-start 5套35/35无跳过。此前完整测试对照仍见原任务会话验收报告，不把旧全量数字当成本次新冻结全量。

PR170 新归档脚本另跑41项：36通过、5失败。5项都需要本云端不存在的 pwsh；没有安装替代工具、关闭检查或改写断言。本轮不执行该历史部署脚本。

## Windows 现场差异与验证边界

百部原候选91项82通过9失败。逐项分类：1个SQLite after清理顺序导致EBUSY，1个路径分隔符断言，4个系统不允许创建symlink，3个Linux shell夹具误用System32/bash.exe进入缺/bin/bash的WSL。现场仅替换官方PowerShell夹具后，service19项已通过；这是现场临时验证，不等于本增量候选已安装。

本增量保留Linux bash，Windows采用官方 pwsh provider及同等实际命令；不放宽原并行、取消或需求版本断言。SQLite统一先关闭再删除；路径使用node:path.sep。symlink权限不变更，未验证场景保留缺口，不能记为通过。

云端 Chromium 环境仍不可用，实际浏览器视觉/交互尚未验证。上轮干净安装因既有锁供应链发布时间限制未通过；本轮使用已安装依赖的测试不替代干净安装。新数据根、domain、发送者身份与实际UTC切换时间由现场确认，源码不填造值。

Windows 便携性测试增量完成后，在 Linux 再跑5套：`task-session-service-native`、`dynamic-task-store`、`task-session-material-history`、`task-session-clean-start`、`task-clean-ingress-native`，55/55通过，0跳过。该增量仅改4个测试/fixture文件，生产代码仍与568e5ae一致；Windows最终候选仍须由百部复测。没有把4个symlink权限失败改为skip或删除断言。
