# 消息上下文预算修复验证（第 30 轮）

日期：2026-09-24。对应审查：`docs/spec/message-context-budget-review.md`。第 29 轮保留修复前失败证据，本轮只记录修复后结果。

## 修复与验证

| 用例 | 结果 | 独立证据 |
| --- | --- | --- |
| 明确引用候选保护 | PASS | 隔离探针保留 8/8 个明确候选，遗漏 0；超过保护集合时留可见容量状态。`round-30/budget-probes.json` |
| R 材料传给 I | PASS | 补取材料同时在关联与意图输入可见；长材料保留限制和原文引用。`round-30/budget-probes.json`；定向测试 `R补取的长材料尾部限制进入I与效果命令` |
| 固定 S 不占模型额度 | PASS | 探针 `judgeCalls=0`，S 完成；后继 R 自身超限单独报告。`round-30/budget-probes.json` |
| 已解决请求后恢复 R | PASS | 旧 R 阻断携带已解决请求时重新尝试原节点，不重跑 S；探针因人为设置 2,800 字节保护值仍保持可见阻断，未声称业务完成。`round-30/budget-probes.json`；定向测试 `旧R容量阻断含已解决材料请求时恢复原节点且不重跑S` |
| 定向回归 | PASS | `TEMP`/`TMP` 指向 `D:/dsh-test-temp` 后，`node --test test/message-workflow.test.js test/message-ledger.test.js test/workflow-service.test.js`：93/93。首次使用系统盘临时目录因 ENOSPC 失败，属环境故障，已保留日志。 |
| 全仓回归 | PASS | 同一临时目录下 `npm test`：888/888，失败、取消、跳过均为 0，耗时 251132 ms；日志位于本机 `D:/dsh-test-temp/full-tests.log`，不入库。 |

实现仍使用 UTF-8 字节作为本地请求保护值及 token 预留的保守上界；提供商返回的实际 usage 单独入账。没有经过模型 tokenizer 校准，故不能把本轮测试视作真实 token 成本或消息 P95 的达标证据。未执行真实渠道发送或运行实例切换。
