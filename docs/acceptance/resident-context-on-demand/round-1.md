# Round 1

## 结论

源码、协议、安装包、本地运行态和最近消息复核全部通过，本轮全绿。

## 代码与预算证据

- 定向 Runtime 回归：88/88 通过。
- 全量 `npm test`：183/183 通过。
- 使用当前持久化数据重放最近 30 条消息：新 Steer 长度最小 232、中位 244、最大 1,203 字符；30 条均未出现候选正文。
- 当前 Task 索引从 46,697 字符降至 8,082 字符；完整 Task 数据未删除，由读取工具按需返回。
- `git diff --check` 无空白错误，仅有 Windows 工作区 LF/CRLF 提示。

## 安装包与插件证据

- 部署代码提交：`5857bdf`。
- Assistant tgz：89,569 bytes，SHA-256 `6CB0FD4442166108B6736051A5CF4BD4849AA6E8DC9A6729F06E5848B08B4ABD`；安装后的 `runtime.js`、`decision.js` 与源码 SHA-256 分别完全一致。
- 根包和 Observer tgz 也完成真实打包，SHA-256 分别为 `ABD59D9D1C2F05E1D386A4155498B2DA1F30EE644C15C00ADEDBB39BB3625BDE`、`C1DF3A48850F387B4C22E49190761F9BFB826AF50CC2D64F92C9011FC569A33F`。
- `@zzusp/dsh-compaction-convergent` Release `v0.1.1-rc.2-convergent.6` 非草稿、非预发布；下载 tgz SHA-256 为 `9741E0FAA6C2DF7AA97FBE1F67CCD4F76C7B9E50B0E3071DFFE0964F24E9B561`，与 Release digest、`.sha256` 和 `provenance.json` 一致。profile 安装 manifest 回读版本为 `0.1.1-rc.2-convergent.6`。
- DSH 展开配置中官方 `compaction-basic` 保持禁用，仅启用 `@zzusp/dsh-compaction-convergent`；Resident 使用 `standard-convergent`。

## 本地运行态

- `restart-dsh-web.ps1 -Check` 通过后完成重启。
- Node PID `44928` 同时监听 `127.0.0.1:3080` 和 `127.0.0.1:18998`，Web HTTP 200。
- `/health` 为 `status=ok`、`inboundProcessing=true`、`recoveryIssueCount=0`。
- DWS 群 listener 和个人回复 listener 均为 `ready`，backfill 为 `ok`，bridge `healthy=true`。
- 原 Resident Session `session-group-00fb7328cc47085feddbf03e-87f62c1b` 在重启前后保持不变。

## 最近消息复核

- 用同一 DWS profile 按 ID 回读 sequence 651—658 及 sequence 654 的被引用消息：请求 9 条、命中 9 条、失败 0、未命中 0。
- sequence 653 正确创建并完成“复查今天下午群消息”任务；已有确认和结果回复均已投递。
- sequence 654 是另一 Agent 对既有结果的任务回执，sequence 656 是表情；两条均未建 Task 或发送多余回复，符合语义。
- sequence 655、657、658 已一起进入既有 HiQLCD Task 的第 2 轮；当前目标明确包含撤销第一阶段关联、迁移到“管理信息—LCA 方法论报告”以及优先验证 Bytebase MCP，Task 状态为 `running`。
- 未发现漏建、错挂、错回或越序，不额外向真实群发送重复确认。

## 验证边界

本轮没有为验收制造一条新的真实群消息。已验证既有消息精确回读、持久化处理状态、运行时代码和服务健康；部署后下一条自然消息的实际 Steer 体积继续作为观察项，不将源码重放冒充新的群业务 E2E。
