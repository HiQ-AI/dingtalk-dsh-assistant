# 历史错误澄清恢复验证

新增严格分支只允许零业务命令、当前 pending coordinator 澄清、同群已送达通知且撤回证据齐备。保留来源作者正文，递增版本，不生成 answer；当前策略由 ingest/reprocess 共用构造。

定向命令 `node --test --test-name-pattern "旧协调澄清|本机操作者逐条重处理" test/message-ledger.test.js test/workflow-service.test.js`：3/3 PASS（1920.8269 ms）。覆盖合法恢复、未撤回/发送中/未知/其他节点/已结束请求/业务命令拒绝、服务身份限制及当前策略。

全文件 `node --test test/message-ledger.test.js test/message-workflow.test.js`：120/120 PASS（48249.7384 ms）。日志 docs/tmp/clarification-tests/sg8-ledger-workflow.log；TEMP/TMP 指向同一 D 盘隔离目录。git diff --check 通过。

最小原生操作：先通过通知撤回流程取得核验成功的 recallEvidenceRef，读回原消息 commands=[] 及 pending 旧 coordinator 澄清，再本机 POST /workflows/<原runId>/reprocess；读回旧请求 superseded、新run来源版本递增及唯一业务候选。此轮未调用该写入口、未部署、未发送消息。

受管通知操作补充：HTTP 仍限定本机及可信 Origin；省略 authorizationRef 时由 Host 注入配置 webActor，只允许 explicit_user，持久化授权引用。执行核对同身份、同通知快照摘要，只有真实 DWS 撤回回读成功才落 recalled 证据。群负责人原授权路径保留；客户端自报 actor 或 SUCCESS 回执不接受。

最终组合 `node --test test/http.test.js test/message-ledger.test.js test/message-workflow.test.js`：154/154 PASS；服务撤回/重处理定向 3/3 PASS。服务当前策略定向已由前述3例覆盖。HTTP 非本机地址测试另2/2 PASS（含对实际handler注入非loopback地址）；组合测试在该测试追加前启动，不混算数量。
