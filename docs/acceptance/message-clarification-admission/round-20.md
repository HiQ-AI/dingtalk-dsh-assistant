# Task 文档正文读取

## 现状与实现

原Task已创建但等待正文和UAT；本轮从当前冻结需求独立回读四条来源及sourceVersion，文档来源确实在scope内，历史attachments为空。缺口是只读能力仅接受fileId/mediaId，不是已经证明文档权限不足。

复用DWS profile、资源读取器及Task查询证据。严格解析alidocs节点链接；旧正文派生引用须核对群、作者、版本和原文，读取前再次核对远端消息。新文档链接不自动提升为创建Task的前置条件。Owner先读取再判断，缺UAT只阻止依赖环境的工程阶段。

## 已完成测试

- `node --test test/dws-bridge.test.js test/dws-adapter.test.js test/coordination-resources.test.js test/task-owner-session-native.test.js`：130/130 PASS，3201 ms。
- `node --test test/agent-query-tools.test.js`：15/15 PASS，2716 ms。
- `node --test --test-name-pattern '旧消息正文中的钉钉文档|文档链接进入原Task|平台附件|直接Task附件scope' test/workflow-service.test.js`：6/6 PASS，1731 ms。
- 查询工具与Owner补充测试：43/43 PASS；真实DWS错误枚举能够返回Owner继续判断，未知错误和验证失败不被吞掉。
- 反例包括任意文档ID、跨群/旧来源、正文漂移、片段/缺正文、不完整、权限错误不走公网HTML；新旧附件投影两例都先创建Task、Owner两次完整读取后保存一条查询证据，原来源不被改写。

## 产物与现场验证

首版包SHA256 `894628677883893f0989d10c748cdb1b526985038ed207fa005f83141aff5cfd`，独立包源码比对100文件一致。部署零写Check通过，安装及新PID60344确认，历史4Task保持。原Task只读重评accepted，原session不变，Owner revision5、event305进入pending；system recovery工件明确列出原文档节点为可读资源。

本轮工具进程直接DWS调用返回旧认证上下文，未再次登录。现场读取由同一已授权计划任务启动的Runtime执行。DWS v1.0.63官方实现证实doc.content.v1及JSONML合同；目标节点的真实类型和内容仍需现场验证。

## 现场反证与下一轮

首版现场正文验收未通过。原Owner被同群四条routing_pending挡住，纯只读门禁返回MESSAGE_INPUT_PENDING；主群回补报GROUP_COORDINATOR_SESSION_ALREADY_LIVE，认证监听均ready。恢复入口accepted不是正文证据。

同一Windows Principal的原生只读诊断确认节点FILE/html；doc fetch明确拒绝非adoc，且真实成功协议是统一ok/outcome/data信封。首版仅支持adoc不足以读取此资料。drive download得到57222字节，SHA256 `edc1b1b805cf37bed0bcf5e4984a419d903fc8c2a1cf523d162c38e414d026f1`，原生UTF-8文本包含40标题、5表格和UPR/待入库/导出规则。此文件只在docs/tmp，未提交正文。

两次临时诊断计划任务均在完成后删除并独立查询不存在；没有改现有计划任务、重新登录或复制凭据。修正类型分流和受管会话恢复见round-21，不覆盖本轮失败记录。
