# 第 2 轮：固定版本摘要历史合同基线审查

日期：2026-11-03

## 结论

routing-review 对当前未提交工作树与精确基线 `c80d42bf747cb950aa03ab7906194123bfc5683a` 做单项对照，成员报告两侧均为同一测试失败。因此记录为未解决 `FAIL`、非本轮引入；不修改源码/断言，也不把失败豁免或折算成 PASS。该结果只覆盖此历史投影合同，不构成对本特性功能的最终验证。

## 版本身份与比较证据

审查执行时分支为 `worktree-topic-routing-quality`，HEAD 为上述 c80d42bf；共享工作树有未提交产品改动及新增验收文件。**仅在该次取证时** `test/topic-store.test.js` 无 diff。routing-review 报告以下精确对象身份：

- 基线 `packages/dingtalk-dsh-assistant/store.js`：blob `86e9c9a5c562541ef6f78713d30b03582f7782b0`。
- 基线 `test/topic-store.test.js`：blob `d75de47afa584196b0f0bb0396549108089b53e8`。
- 当前测试文件哈希与基线测试 blob 相同、当前工作树 `store.js` 与基线 store blob 相同，**均指 D 执行该次 hash 取证时的工作树**。
- 成员报告曾用 `git hash-object` 对临时归档中的基线 store/test 与当前测试求哈希，并用 `git rev-parse c80d42bf:<path>` 确认基线 blob；临时归档目录已由成员删除。此次不重复生成临时副本或运行测试。

## 运行结果

当前工作树命令：

```powershell
node --test --test-name-pattern='固定版本不暴露后来摘要' test/topic-store.test.js
```

精确 c80 基线命令：

```powershell
node --test --test-name-pattern='固定版本不暴露后来摘要' docs/tmp/routing-review-c80d42bf-baseline/test/topic-store.test.js
```

两侧均 exit 1：1 个测试、0 pass、1 fail。失败用例为 `固定版本不暴露后来摘要，旧决策完成不关闭已收到新输入的话题`（`test/topic-store.test.js:461`）；断言位置 `:472`，actual 为 `第一版`，expected 为空字符串。成员说明 `store.getTopicContext`（`packages/dingtalk-dsh-assistant/store.js:867-876`）会从已完成 revision 1 的 `priorUpdate` 重建摘要；现有证据不支持将其解释为 revision 2 内容泄漏。基线与当前源码/测试字节相同，故**在 D 取证时**当前失败不是本次增量导致，但合同仍未满足。

D 随后独立回查 HEAD 与 reflog -1 仍为 c80d42bf，但发现 `test/topic-store.test.js` 已被其他成员修改；该新状态不改变此前哈希与运行结果的时间边界。D 未修改该文件，也未重跑。后续轮次应以稳定后的源码单独验证，不能用新文件状态倒改本轮结论。

## 范围隔离

此项与 round-1 中 `topic-runtime.test.js` 的 8 个 workflow 旧合同失败相互独立。D 的基线对照不能表示那 8 项已修复；仍需 core 提供修复后实跑证据。整合后的功能回归、测试映射 check、真实模型质量、部署和真实钉钉消息仍未由本报告验证。
