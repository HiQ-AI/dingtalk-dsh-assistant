# Round 2：本地集成部署与运行态回读

## 结论

GRC-18、GRC-19 通过。本机原运行态已加载审批引用回复分支，为避免部署本修复时回退该能力，使用 `feature/approval-reply-live-events` 与本修复两次提交构建临时集成包；交付 PR 分支仍只包含群回复链路修复。

## 集成与产物

- 临时集成提交：审批分支 `7b7bb6f` + 本修复 `ba5d0ee`、`3b7d83e`。
- 集成工作树执行 `pnpm test`：154/154 PASS，0 fail、0 skipped。
- 本地安装包：76,168 bytes，SHA256 `1691D9FE6F02A77990F02D64970697FB74DA41FA1CE01DACF9E4B2DB997B74B0`。
- profile `package.json` 已指向新的唯一 tgz 路径；安装后的 `runtime.js`、`dws-adapter.js` 与集成工作树按 Git 内容比较均无差异。
- 安装源码独立回读同时命中：两个 stale 结构化返回、普通 Decision 的 `replyToMessageId` 映射、引用 ID 优先回读校验，以及并行审批分支的个人回复 listener。

## 重启与运行态

- 完整停止旧 PowerShell/Node/DWS 进程树后，以 `scripts/start-web.ps1` 隐藏启动；启动父进程和 Node 子进程持续存活。
- Node：v24.19.0；`127.0.0.1:3080` 与 `127.0.0.1:18998` 由同一新 Node 进程监听。
- Web 首页：HTTP 200。
- `/state/version`：current/latest 均为 0.5.10，`updateAvailable=false`。
- `/health`：`status=ok`、`transport=dws`、`inboundProcessing=true`、`outboundAuthorized=true`、`modelMode=real`、`recoveryIssueCount=0`。
- `/state/dws-bridge`：`healthy=true`，2/2 群 listener 为 ready 且 backfill 为 ok，个人回复 listener 为 ready。
- `/state/groups`：2 个配置群均可读取；重启 stderr 为 0 bytes，无 error/exception/unhandled 命中。

## 未完成边界

- GRC-20 尚未在真实群产生一条部署后的自然业务回复，因此没有新的 DWS 引用消息回读证据。为避免向业务群制造测试消息，本轮不把单元测试、安装源码或健康接口冒充真实群 E2E。
