# 时间修复导入与回归

用户批准任务消息传递补丁；没有重试被拒 Library 下载。导入前父提交 `9c7646ca0a7d82f21202388ba808acafc230cc21`，百部原提交 `707766a74d5f313b2499c6636459760a3511f840`，云端代码提交 `cbd249ed76cc6c632904a9a9a91585867f6476a8`。提交元数据不同，代码 tree 精确相同：`f24af35ec48a2b2dde55adbe4615313205400554`。

原样补丁保存在 `/workspace/coordination-repair-import/message-repair.patch`，UTF-8/LF，10,588字节、162行。应用前核验 SHA256 `058fa4f5e90508b3c958d0d33007ce6be0d87702c5a14d3d214a89f02d391b79`，再运行 git apply --check 与索引应用。应用后核验：

| 文件 | 字节 | SHA256 |
|---|---:|---|
| packages/dingtalk-dsh-assistant/coordination-time.js | 5393 | a5e6b1fd1e2722a6863880b28978c4ca5452fc2ff0cc7b71877a660b5e7a0832 |
| packages/dingtalk-dsh-assistant/independent-coordination-planner.js | 16147 | cf9363b96d4e6d8f4f206b9203876fd15a9fc034e43030795109be9f22de99ac |
| test/coordination-language-replay.test.js | 3680 | 6bfda336ab955f209975ac2b99931acbf1e166fec69f2431b1eb028e505dd9d8 |
| test/coordination-schedule-revisions.test.js | 10068 | 4038490a92c31445840acf13e451d25f56ba0cc5d5314b108da5151ae182dc36 |
| test/coordination-time.test.js | 2499 | 6e854f1936f63846976649bcffcc7df80f69aec7c10a20546627a3c7de69a3b5 |

独立审查未发现实质问题，未修改实测代码树。显式时区输入先通过日历往返校验，再转规范 UTC；无时区、非法日期、未知偏移和非零小数秒拒绝。持久化校验和精确期望均未放宽。工具输入 schema 转换正常。审查者另跑时间/回放9项通过（与下列重叠）。

云端当前代码定向回归（Node24，隔离数据库与适配器，无真实模型或渠道调用）：

```powershell
$env:DSH_NATIVE_TEST_PROFILE='test/fixtures/native-profile/package.json'
node --test test/coordination-time.test.js test/coordination-language-replay.test.js test/coordination-schedule-revisions.test.js test/independent-coordination-native.test.js test/independent-coordination-changes-native.test.js test/coordination-recurring-native.test.js test/coordination-reorder-native.test.js test/coordination-final-native.test.js
node --test test/coordination-trigger-commands.test.js test/coordination-conditional-query.test.js test/coordination-concurrency-contracts.test.js test/coordination-final-fault-matrix.test.js test/independent-coordination-recovery.test.js test/coordination-standard-model-adapter.test.js
```

第一组34通过、0失败、0跳过，6,838ms；第二组67通过、0失败、0跳过，944ms。原始日志保存在 `/workspace/coordination-final-evidence/coordination-repair-native-regression.log` 与 `coordination-repair-risk-regression.log`。没有将历史或百部重叠测试累加为本树全量。测试分类更新只增加三条测试文件的 import 依赖，不改变发布分类。

真实模型20次修后成功响应与25次百部总尝试、24次完成分开报告，原报告未云端导入；详见 [回放状态](./real-language-replay-status.md)。原始JSON摘要仅为任务消息提供值。费用未知。未做真实钉钉送达或生产迁移，未推送、建PR、合并、部署或发版。
