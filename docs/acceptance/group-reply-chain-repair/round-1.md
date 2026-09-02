# Round 1：源码与产物回归

## 结论

GRC-01 至 GRC-17 通过。两类现场观察失败均已由同形参数回归覆盖：提交请求自身不再要求重复声明，通知发送期间真正出现的新消息仍执行零副作用 stale。普通 Decision 的引用元数据已贯穿 Runtime → Store/Outbox → DWS reply → 回读匹配，且回读不再用“正文相同”绕过引用 ID 校验。

## 现场证据

- Resident Session JSONL 显示首个 `group_decision_submit` 已在 submission 中提交现场请求（ID 已脱敏），但未重复提供顶层 `observedRequestIds`，12 ms 后返回 `missing`。
- 同 turn 下一 step 补齐相同 ID 后工具成功；持久状态显示入站消息最终为 `delivered`，Outbox 为 `sent` 并具有真实 `deliveredMessageId`。
- 该 Outbox 没有 `replyToMessageId/replyToSenderOpenDingTalkId/atOpenDingTalkIds`，证明最终发送成功与引用路由成功是两个不同层次，旧实现只完成前者。
- 另一现场 `group_reply_submit` 在通知生成后遇到新进入的普通消息，第一次以空 `observedRequestIds` 提交时返回 `missing`；同 turn 先处理该普通消息，再次提交通知成功，最终显示仍有 0 个待处理请求。该流程证明 stale 拦截本身必要，但不应以工具失败卡片呈现。

## 实现与回归证据

- `group_decision_submit` 使用“已提交普通请求 + 显式 observed”的并集校验；单请求只写 submission 一次通过，另一 pending 未观察时返回 stale 且 Task/Outbox 均无副作用。
- Decision 与 Task 通知 stale 均返回 `status/missingRequestIds/pendingRequestIds`，工具 render 包含缺失 ID，供下一 step 重生成。
- 普通单请求引用当前入站消息；入站自身引用旧消息时不会错误回复旧消息；合并请求选择最新有效发送人；发送人 ID 缺失时不构造伪引用。
- `matchesOutbound()` 先校验 quoted message ID，再比较规范化正文；新增反向断言覆盖无引用和错误引用但正文完全相同的情况。

## 命令与结果

- `node --test test/runtime.test.js test/fake-llm.test.js test/dws-adapter.test.js test/store.test.js`：81/81 PASS。
- `pnpm test`：150/150 PASS，0 fail、0 skipped。
- `git diff --check`：通过，仅有 Windows 工作区的 LF→CRLF 提示，无空白错误。
- 三个实际 npm 包均成功生成并回读：
  - `@zzusp/dingtalk-dsh-assistant`：75,172 bytes，SHA256 `9CF104C8A20566B77A06742808DE51B952940CBA01CE8D415626C2CB8D8EB8CE`；内容包含修改后的 `runtime.js` 与 `dws-adapter.js`。
  - `@zzusp/dingtalk-dsh-observer`：14,693 bytes，SHA256 `6589023C4DCE9FEDF88998F78139D8824C699DAF5C00864E1D30E6B73B27A766`。
  - 根包 `dingtalk-dsh-assistant`：15,212 bytes，SHA256 `1FF800D57B3C3325242A17F31A20449CB4C5F18BFDA7C78E1BD54E0182F59AE8`；包内 manifest 已将 `workspace:` 依赖改写为普通 `0.5.10`。

## 未完成边界

- GRC-18、GRC-19：尚未安装到本机 `web` profile 并重启读取运行态。
- GRC-20：尚未执行真实群引用回复；单元测试和包内容不能替代 DWS 渠道回读。
