# Round 1 验收记录

## 环境

- Windows 11 / PowerShell 7
- Node.js `v24.19.0`
- pnpm `10.13.1`
- 分支：`feature/resident-reply-steer-barrier`
- 基线：`e4a7c4a`

## 结果

- `node --check packages/dingtalk-dsh-assistant/runtime.js`：PASS。
- `node --test test/runtime.test.js`：48/48 PASS。
- 复杂组合、提交失败和生命周期竞态关键用例连续运行 20 轮：20/20 PASS。
- `pnpm test`：147/147 PASS。
- `node scripts/build-web-client.mjs` 后执行 `git diff --exit-code -- packages/dingtalk-dsh-assistant/web-client.js`：PASS，生成物无漂移。
- `git diff --check`：PASS；输出仅包含 Windows 工作区 LF 将转换为 CRLF 的提示，无 whitespace error。
- 三个发行包均成功生成并独立回读数量、大小与 SHA256：
  - `dingtalk-dsh-assistant-0.5.10.tgz`：14956 bytes，`377A7A4DD1DE4E015EDD0F76C0491E92844B81D46873891BAE4A755361797744`
  - `zzusp-dingtalk-dsh-assistant-0.5.10.tgz`：74763 bytes，`1E38200B2733ABC2B012202A557C5EB732D197049812673FB7C8412D990176B4`
  - `zzusp-dingtalk-dsh-observer-0.5.10.tgz`：14693 bytes，`45CA1F43CA5936C3561A74987DDC53FA55B187B583CECE21C4389DCC87EB8FD9`

## 用例证据

- RSB-01～04：漏观察原子拒绝、相关消息合并、不相关消息仅观察，以及 A+B 相关、C 独立、D 留待后续的四消息组合均通过。
- RSB-05～09：Decision 提交门禁、无回复路径、附件 effective reply、recheck 和跨群并行均通过。
- RSB-10～13、22～24：Task 通知 stale 重生成、独立工具提交、Task 尾链解耦、同群门禁、首次完成补发和关闭边界均通过。
- RSB-14～21：`steered` 状态失败、active submission、退订复核、Outbox 写入失败、live 与缓冲监听器异常隔离均通过。
- RSB-25～28：配置切换、历史导入、transition 后到达操作、退订和关闭的双向调度均通过。
- RSB-29：退订群历史 Task 被跳过，异常 Resident 单项失败不阻塞后续有效群补发。
- RSB-30：全量测试、生成物检查、静态 diff 和三包打包均通过。

## 独立审查

两轮独立只读审查均未发现 P0/P1。审查确认 Runtime 只校验 `observedRequestIds` 的同群 pending 快照，相关性仍完全由模型通过 `submissions` 表达；每群 reply admission 不会串行其他群或所有 Task。

## 边界

- 普通 Decision 的 Outbox 持久化失败会明确失败并进入既有 `decision-failed` 终态，不自动重放可能已经提交的 Task 动作。
- 当前自动化验证覆盖 Runtime 协议和 fake adapter；没有把 fake 单请求行为表述为真实模型对复杂群语境的语义 E2E，也未在真实钉钉群发送消息。
- 协议保证当前进程内的提交顺序，不承诺跨进程事务或崩溃窗口 exactly-once。
