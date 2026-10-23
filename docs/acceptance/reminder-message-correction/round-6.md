# 第 6 轮：入站发送门禁与 DWS 键修复

第 5 轮真实失败后补充实现，不覆盖上一轮结果。当前本轮代码验证通过，真实群复验另记新轮。

## 实现与反例

- 发送许可事务按 source 的准入 rowid 查找同群同作者后续未完成来源，同秒与客户端时间倒退仍暂缓。暂缓抛出专用可恢复信号，不落拒发回执、不增加 attempt；同一个 start 命令在处理完成或重启后可继续。
- Host 对原消息版本及全部 active units 投影本轮处理完成，协调账本批量校验决定；needs_clarification 不等于还没做判断，持久 handoff 也不会永挂。完成事件只释放曾因来源处理暂缓的通知，不清除 unknown/限流去重。未完成来源查询新增部分索引，避免每次扫描全部后续来源。
- 既有 resolvedBy 与 schedule revision 门禁继续退役旧回复；不同事项完成判断后恢复原回复，不同人/群不阻塞；starting/unknown 不退回发送。
- DWS 群发/引用/文件/私聊统一使用最多 128 字符的外部幂等键，超长原 ID 使用固定前缀和完整 SHA256，短键不变；回读验证同一映射，仍保留正文、引用、身份检查。
- 完整持久 uuid 参数拒绝严格绑定原许可、payloadDigest、fence、唯一尝试、原长度和无 ACK/receipt。只有明确未发送证据才沿官方 reconcile 置 failed、同步 occurrence，保留负回执且不重发。泛 PARAM_ERROR、缺 stage、网络错误、已有 ACK/receipt、错误长度/许可和 starting 均拒绝自动结清。

## 实跑

环境：Windows PowerShell 7，Node 24，`DSH_NATIVE_TEST_PROFILE` 显式指向 `test/fixtures/native-profile/package.json`。

```powershell
node --test --test-concurrency=1 test/dws-adapter.test.js test/dws-file-adapter.test.js test/task-notification-readback.test.js test/notification-pending-source.test.js test/task-notification-delivery.test.js test/task-operator-notification-scan.test.js test/independent-coordination-changes-native.test.js test/independent-coordination-recovery.test.js test/task-source-replay-native.test.js
pnpm test:release-smoke
node scripts/test-suites.mjs check
git diff --check
```

- 定向回归：148/148 PASS、0 fail、0 skip，46.214 秒。覆盖最终部分索引和全部实现。
- Release smoke：14/14 PASS、0 fail、0 skip，37.623 秒；实际 tarball 提取并启动隔离 resident。
- 测试映射：303 文件各出现一次，历史 3，删除 0；新增测试归入 native，既有 release 成员未删除。
- 独立审查：首次发现“处理完成但 attempted 集合仍阻止续发”的竞态，修复后复验 81/81；该集合是上述回归的子集，不重复计数。无剩余功能阻断。

原生慢规划用例由受控测试规划器驱动，证明并发时序与持久门禁，不冒充真实模型或钉钉送达。真实第 5 轮负回执只读调用纯校验 helper 确认匹配，业务状态未在测试期间修改。
