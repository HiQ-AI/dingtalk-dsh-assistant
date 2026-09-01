# Round 1：源码与发行包验证

## 结果

GD-01 至 GD-10 全部通过；本地安装与运行健康留到 GD-11 单独回读。

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

## 尚未覆盖

- GD-11 尚未执行；本轮不声称本地 DSH Web 已运行本分支代码。
