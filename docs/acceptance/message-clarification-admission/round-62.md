# 第62轮：群聊结果清晰排版与精确材料参数纠错

## 通知

Owner summary schema仍为string，未改变任何工程factory或业务状态；完成摘要要求【结论】【结果】【下一步】，2–3短重点，排查完成但尚未修复须说明。formatter仅按作者显式换行增加段落空行，不做关键词改写或句子截断。旧长报告完整保留。业务补充/权限请求用condition.missing、responsibleParty和resumeWhen，消息澄清/授权也加清晰标题；无Owner的旧任务终态使用同一结果路径。原消息引用保留，详情不编造外达链接。

实跑workflow-notification-obligations.test.js 59/59 PASS（29720.8ms，docs/tmp/notification-clarity-final.log）；group-reply-audience + task-owner-session-native + dws-adapter 64/64 PASS（5481.8ms，notification-clarity-native.log）。前次基础62/62记录notification-clarity-first.log保留。人工展示fixture明确区分调查未修复与修复完成，不冒充从旧长文自动提取摘要或实际业务验收。原生Owner提示/schema、实际DWS compileGroupReply的--content与ref-msg-id逐字核验，段落空行及已知mget硬换行等价读回通过；删除重点或SQL FOR UPDATE SKIP LOCKED片段不能通过sameDeliveredText。

仓库适配器没有删除SQL逻辑，测试确认含反引号SQL完整传入DWS参数。外部DWS二进制renderer是否曾删除片段仍未收敛，没有实际原消息回读证据不猜结论；未发送现场通知。

## SG20短SHA同因参数恢复

repositoryInspect仅将sameTask/source=current的1–63位hex SHA引用识别为明确参数错误，返回error.code/reference原值及索引suggestedCall；不补hash。跨Task短SHA仍scopeError。历史分类仅精确原生单错误、相同Task短SHA材料调用、无提交/其他工具动作；其他错误不放宽。

materials/共享材料定向19/19 PASS（3830.8ms，docs/tmp/sg20-material-argument-final.log），后续精确foreign scope code反例1/1 PASS（5537.1ms，sg20-material-foreign-final.log）。覆盖真实registry反馈、原生同会话查索引后读完整ref、8类历史正反例。

实际原session7a31b31f-90ac-44ba-8fa3-42b38b20a7a4 JSONL只读证明：输入seq10、材料工具call122/error123、turn-end125；inspectLegacyTurnFailure返回QUERY_ARGUMENT_INVALID。脱敏身份/序号证明docs/tmp/sg20-short-reference-native-proof.json，脚本verify-sg20-short-reference.mjs。原错误工件/输入/lease不修改；部署后由service既有重分类与Owner原节点恢复路径继续，不新增恢复接口，不手写现场账本。
