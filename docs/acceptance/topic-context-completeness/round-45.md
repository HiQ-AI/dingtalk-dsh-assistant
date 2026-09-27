# 第45轮：回声节点收尾修复后重跑独立群验收

承接第44轮部署前排空失败，不覆盖原失败证据。C66 为自身通知回声封存后，模型节点终结、迟到结果拒绝及旧记录原生修复；C61–C65 延续独立群、普通回复、新群接入、真实渠道送达和防重复检查。

本轮已完成修复、受控恢复、正式部署及两条真实消息验收；最终防重复结果见下文。

第一次恢复执行在零写资格检查被拒绝，维护仍 inactive/revision 30，证据目录未创建。原因是新反例门禁一律拒绝 pending barrier，而真实回声在入站时引用原消息，产生了 self-owned 的来源屏障。独立 API/控制账确认屏障的 targetSourceKey 同时匹配回声 quoteRefs 和已送达通知所属来源。按这组证明精确释放自身引用屏障；不释放任意任务、其他所有者或不匹配来源的屏障。此失败保留，不把此前无屏障副本验证当作最终事故验证。

## 现场受控恢复

- 修正后 14/14 回声定向用例通过；主代理独立复制实际控制库验证原生命令收尾 1 节点、1 屏障，重复 receipt 幂等，live 前后摘要不变。证据 `docs/tmp/round45-echo-copy/actual-copy-repair.json`。
- 正式维护后，同一 Host PID 30236 完整退出 Resident，取得 ready/disposed 的 nonce 见证；独占锁内备份并验证，再原生命令收尾。原 profile SHA256 恢复为 `39738ce3fae5facb46590a044ba1d86e90816cad609aaa31d0878ed9eb24352b`。
- 独立 HTTP 回读：maintenance active/draining、revision 31、drained=true，nodes/owners/effects/messages 全为 0；旧 echo 节点 superseded/priorStatus=failed、barrier resolved/outbound_echo，commands 仍为 0。保持维护供正式部署接续。证据 `docs/tmp/round45-echo-recovery/repair-readback.json`、`resident-readback.json`。

## 定向测试与正式部署

- `node --test test/message-ledger.test.js test/message-workflow.test.js test/workflow-service.test.js`：235/235，通过普通回复、真实回声封存、模型中止、迟到拒绝、引用屏障及原生恢复反例。日志 `docs/tmp/echo-reconcile-final-related-tests.log`。
- 空群接入/备份/历史结构相关测试 22/22；恢复相关测试 9/9；主代理独立恢复测试 4/4；PowerShell 部署脚本 30 个断言通过。各组存在重叠，不累计宣称总数。
- 本地安装包 SHA256 `24499c3a2497b8fd61bf2d7f659101a75c4c7cd21b844fadb56286ddd5345b65`，85 个源码、包和安装文件独立比对一致。首次部署新 PID 26820，maintenance inactive/revision 33，busy 全 0，health ok，inboundProcessing=true，recoveryIssueCount=0。
- 新群 enrollment ACTIVATED；原 sealRef 保留，profile SHA256 `b256ee3aeaeb64e346a45f20c2afc4563a93e35520a050c2ec70b718617210be`。原 84 个任务、76 个旧节点、21 个终态运行保留。计划任务独立回读 Ready。首次部署报告的 scheduledTaskChanged 曾硬编码 false，实际恢复见 enrollmentAutostartRestore 和计划任务状态；已修报告表达，没有修改旧证据。

## 独立群真实业务验收

群名 `DSH端到端测试-20260927`，群 ID `cid2HnVI0zvC2dOr5RmJ5ZCJg==`。成员完整回读确认唯一人类是当前账号，另有内置 AI 小钉，未邀请同事。测试没有向业务群发消息。

| 用例 | 真实来源消息 | 真实回复消息 | 结果 |
| --- | --- | --- | --- |
| A：只回复、不建任务，提供口令 | `msgkR3TVnHzYRJ+6dWWn+Jd2A==` | `msgHOZnI4V9tXlbzTSQfq0zNg==` | 回复包含 A 标识、口令青竹472、代回署名；引用精确指向输入 |
| B：连续同话题，不再提供口令 | `msgYhwk6CiDH3IV4haPB7clTA==` | `msgLLwZ93U7Z/FeTbAbTaL3sA==` | 从话题取回青竹472、包含 B 标识和代回署名；引用精确指向第二条输入 |

两个消息运行均 settled、answer applied，落在同一话题 `topic-171dc09fde64b0bf42e6b21399950c25`。完整渠道回读恰好 2 条输入与 2 条回复，outbox 两条 sent 且 deliveredMessageId 与渠道一致。测试群任务 0，全局 84 个任务 ID 集合与基线完全一致。证据 `docs/tmp/round45-e2e/b-readback.json`，基线 `docs/tmp/round44-e2e/baseline-corrected.json`。

边界：当前账号自发测试消息通过正式 DWS 历史补读进入；这验证了真实渠道入站、模型判断、同话题上下文、通知与引用送达，但不代表其他成员实时推送路径已验证。原 C60 的历史失败保留，本轮不写全局全绿报告。


## 补读和真实重启防重复

正式补读同一时间段后，再走完整维护、排空、备份、安装和启动流程；新 PID 9876 替代 26820。维护恢复为 inactive/revision 36，busy 四项均 0、drained=true。部署瞬间 listener 尚在初始化，随后独立回读 health=ok、inboundProcessing=true、recoveryIssueCount=0。

重启后完整渠道回读仍为 4 条消息、2 个 settled 消息运行、2 条 sent 回复、1 个共同话题、0 个测试群任务；全局 84 个任务 ID 与基线逐项相同。两条 quotedMessage.messageId 分别精确匹配 A/B 输入。断言实跑 PASS，未通过重新发送输入或人工代答取得结果。

证据：`docs/tmp/round45-e2e/manual-backfill.json`、`after-restart.json`、`docs/tmp/round45-restart/readback.json`。C61–C66 本轮 PASS；早期失败记录保留。
