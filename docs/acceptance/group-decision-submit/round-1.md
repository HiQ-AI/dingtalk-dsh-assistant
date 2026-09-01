# Round 1：源码与发行包验证

## 结果

GD-01 至 GD-11 全部通过。

## 协议与并发用例

- `node --test test/runtime.test.js test/decision.test.js test/fake-llm.test.js`
  - 多个无关请求可在一次工具调用中分别提交。
  - 后一条独立 Decision 先提交时可先返回，未被前一条 pending 请求阻塞。
  - 相关请求可共享一个 Decision，Task 与 Outbox 副作用各执行一次，来源证据同时包含两条原始消息。
  - 重复、未知、跨群请求以及混入非法 Decision 时整次调用拒绝，pending 未被部分消费。
  - assistant JSON 文本与 `turn/end` 不能完成 Decision；Agent 停稳未提交时记录 `group_decision_not_submitted` 和 `decision-failed`。
  - 自动关联复核也使用独立结构化 Decision 请求。

## 全量与产物

- `node scripts/build-web-client.mjs` 后执行 `git diff --exit-code -- packages/dingtalk-dsh-assistant/web-client.js`：通过，无生成文件漂移。
- `pnpm test`：103 tests，103 pass，0 fail。
- 按 `.github/workflows/ci.yml` 打包根包、assistant 包和 observer 包：共 3 个 tgz。
  - `dingtalk-dsh-assistant-0.5.10.tgz`：14041 bytes。
  - `zzusp-dingtalk-dsh-assistant-0.5.10.tgz`：67332 bytes。
  - `zzusp-dingtalk-dsh-observer-0.5.10.tgz`：14693 bytes。
- `git diff --check`：通过。

## 本地部署与运行态

- 将 `@zzusp/dingtalk-dsh-assistant` profile 依赖切换到 `docs/tmp/deploy-assistant-58d9af3/zzusp-dingtalk-dsh-assistant-0.5.10.tgz` 并强制重装。
- 独立计算源码与安装目录 `runtime.js` 的 SHA-256，均为 `5C3F7CF577041E6780DBE05B66274A89521E339A9B08A13E89AA93E0F5AF9E85`。
- 安装目录回读到 `group_decision_submit` 注册和 `await pending.promise` step 提交路径。
- `DSH Web Local` 计划任务为 `Running`；只有一个 DSH Web 主进程，3080 与 18998 均由同一 PID 监听。
- Web 返回 HTTP 200；Runtime health 返回 `status=ok`、`transport=dws`、`inboundProcessing=true`、`outboundAuthorized=true`、`modelMode=real`、`recoveryIssueCount=0`。
- `/state/version` 返回当前版本 `0.5.10`，`/state/groups` 返回 HTTP 200 且可读取 1 个群状态。

## 边界

- 未向真实钉钉群注入测试消息，避免产生群通知、Task 或外部副作用；多消息组合与副作用行为由隔离 Runtime 用例覆盖。
- 版本号仍为 `0.5.10`，因此运行源码绑定以 tgz 路径、安装文件哈希和代码标记为证据，不以版本号单独推断。
