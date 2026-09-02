# Round 2

## 结论

修正 storage 兼容策略后，代码回归、安装包回读和本地部署全部通过。

## 代码与测试证据

- `pnpm test`：159/159 通过。
- 两个高风险 Runtime 用例连续定向执行：20/20 通过，覆盖多消息多 Task 映射及完整历史通知路由。
- `git diff --check`：无空白错误；仅有工作区 LF/CRLF 提示。
- storage domain 断言：版本仍为 6。

## 安装包证据

- 安装包：`docs/tmp/deploy-assistant-task-message-history-v2/zzusp-dingtalk-dsh-assistant-0.5.10.tgz`
- 字节数：79085。
- SHA-256：`D43C9D60A49FBB5CF2A5A86939320448DC42975BEEBD578F5CBDDF6BD094E825`。
- profile 中已安装的 `runtime.js`、`store.js`、`decision.js`、`fake-llm.js` 均与当前源码哈希一致；安装后的 domain 版本独立回读为 6。

## 本地运行态证据

- `restart-dsh-web.ps1 -Check` 通过，随后重启成功。
- 主进程 PID：28764；监听 `127.0.0.1:3080` 和 `127.0.0.1:18998`。
- `/health`：`status=ok`、`transport=dws`、`inboundProcessing=true`。
- `/state/dws-bridge`：`healthy=true`，已连接 1 个群。
- `/state/recovery-issues`：`[]`。
- Web 首页：HTTP 200。
- 持久化 unit：`dingtalk_dsh_assistant`，版本 6。
- `/state/tasks`：26 个 Task 均回读到消息时间线，且已恢复条目的发送人稳定 ID 均存在。

## 验证边界

本轮没有向真实钉钉群发送多参与人通知，因此这里只证明模型工具协议、Runtime 约束、持久化和本地 DWS 运行态；真实群内引用与 @ 展示仍属于业务 E2E 边界。
