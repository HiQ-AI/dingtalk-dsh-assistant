# Round 17：话题来源身份无损复用

正式 r15 修复恢复后，新 FACT 消息 IB 因 33493/32000 容量阻断；该消息没有业务 command/notification，后续应原生重处理原消息，避免再次新增事实。

只读精确重建命中 33493 字节。相比既有 31552，话题事实由 8 增至 17、来源由 4 增至 6，sharedTopic 增加 5860 字节；unit 从 2 减至 1 抵消部分增长，任务完整事实仍 2800 字节，任务共享未失效。

最小修改仅在既有 shareTopicContext：sourceRefs 每项恰有 sourceKey/sourceVersion 且唯一匹配 sources 时按原序投影为 sourceIndexes；actorId 为非空字符串且逐字等于 sharedTopic.actorId 时用 actorFromTopic。额外字段、缺失/歧义来源、不同发送者保留原对象。IB 提示解释引用；I、schema、权限与预算保持。

先红：ib-r17-red.log 新索引断言失败。修复后 message-workflow + message-ledger 共 131/131 PASS，0 FAIL / 0 SKIP，日志 ib-r17-regression.log。

完整真实原始输入的独立逆还原（verify-ib-r17-lossless.mjs）证明 sourceUnchanged=true、exactRestoration=true；计入新 system 为 31537/32000 字节，余 463 字节（未投影同 system 为 40760）。此为当前输入容量实证，不承诺未来无限增长仍可容纳。服务与清单完整关联回归结果随后补录；部署及正式原生重处理由主任务独立验收。

关联完整回归完成：`node --test test/workflow-service.test.js test/task-delivery-manifest.test.js`，154/154 PASS，0 FAIL / 0 SKIP，99618.6009 毫秒；日志 `docs/tmp/task-unified-file-storage/ib-r17-service-regression.log`。服务模型 fixture 按新索引与发送者引用完整展开后保留原业务断言。源码已冻结，尚未由此子任务部署。

## 正式部署和真实业务最终通过

首次预检发现旧工作区提案文件已不存在并零写拒绝。按当前正式 YAML 导出 directQueries 原值，原生 planAgentQueryResources 证明 updated 与 source 逐字一致，profile SHA仍5d3e9c333eb33f9a38971e1485f2858ede87e810f7ece49def12c88701fc933f。只更换私有提案文件，不改授权或配置内容。

正式 Check：writes=0、online=true、22tasks；可用4522156032字节，required2625576516；99文件包 SHA256 b4b6e6054b6bed3153d07f7417c63350aa701d61a058ec5e35c0021a60c2d507。完整备份 owner-repair-20260929-204319-019 经独立读回 verified=true、20770文件、28表，原生安装7.1秒成功。独立Readback：新PID39624同时监听3080/18998，旧22tasks/76nodes/29runs/68legacy保持，99源码与包相同，Web200/token交换303、health ok、真实模型、inboundProcessing=true、recoveryIssueCount=0、维护inactive。独立msedge无头看板和任务详情PASS，pageErrors=0。

原失败FACT仅有material2/node3/request1/unit1，无command/notification。原生reprocess获得 sourceVersion2、msg-replay-0c498b999b2401f343eb5adcba96433480a0ebd2。S/R/IB实际成功，正式SQLite只读命令核验唯一fact/applied、同task-bf67e52908fd266fa6108536ad88b5ab；run settled。没有再发新用户消息或附件。

最终Task API与原生只读queryTaskOwner及内容寻址的正式manifest独立核验：state=completed/outcome=succeeded；Owner idle、decision.complete、applicationStatus=applied；eventWatermark=processedWatermark=137；清单complete=true/missing=[]，businessValidation.status=accepted，7条验收、10个领域判断，文件1个。API返回manifest指针，实际读取任务work/artifacts对应文件，并验证文件SHA等于引用摘要；不把指针当成清单正文。需求版本2、计划版本1、执行次数1、两个成功阶段保持。旧节点文件output API新detailRevision读回正确附件消息和SHA。

群附件最终再次下载：foundCount1/complete=true/failedCount0，唯一324字节Markdown，SHA b145ad56ad680d1193a6ed6fa7fae0e4d7352e722a1915b1f53ee8891778753e。两个迁移任务18368文件/773430821字节新旧路径SHA与inode/device全部通过；旧API仍completed/succeeded，runSequence3/4、executionCount6/7、结果相等。原始基线JSONL SHA737964d0b28a2d92b7c0e2a9947c93e9eeec1329fb6f2fdd8dbb8d392f05f358及profile SHA保持。

私有证据：deploy-r17-independent-readback.json、live-final-acceptance-proof.json、live-accepted-delivery-manifest.json、live-host-fact-r17-command-proof.json、live-output-final.json、live-file-download-r17-private.json、live-browser-r17/browser-proof.json、task-file-link-migration/independent-proof-r17-restart.json。日志、二进制、下载资源URL不提交；公开结论与历史失败保留本轮文档及matrix。
