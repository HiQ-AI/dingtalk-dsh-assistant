# #320 承接只读工具合同修复

## 结论与证据

#320 的两类空参数调用不是提供方丢失 required：路由原生日志 `session-coordination-76dc87afbfc346136fe63bf5-19f1b847` 的 request/header 明确含 `group_topic_context_get.required=[topicId]`；决策日志 `session-coordination-665a2789bbaa269ce48118bc-72622430` 的 header 明确含 `group_reply_review_get.required=[requestIds]`，均为完整对象根。实际tool/call仍传`{}`；原 handler 没有请求绑定，前者缺少明确Topic，后者虽然会话已固定唯一请求，仍要求模型复写身份，形成无效往返。与前轮根oneOf被Anthropic适配器丢弃是不同故障。

Task目录首包没有预载，不能声称此前已自动给全目录。原 `group_task_list` 返回nextOffset，却不回传query或完整续页参数；实际日志出现筛选条件改变后继续offset13。没有隐藏目录缓存的证据，也不能把每个重复读取都归因模型未看上下文。

## 修复

- 固定决策/审阅请求内 `group_reply_review_get {}` 绑定唯一requestId；显式其他ID及错群仍拒绝。未绑定旧接口仍要求requestIds。
- 固定决策内 `group_topic_context_get {}` 绑定本Topic/revision；原请求或Topic版本变化拒绝。路由没有唯一Topic，仍要求明确topicId，缺参返回结构化topic_id_required及可用nextCall，不偷偷选题。
- 决策首包给出当前Topic与replyReview的精确readCalls。任务目录回传normalized query、当前完整轻量目录fingerprint、带query/offset/limit的nextCall；所有元数据计入原12KiB预算。每次仍读取当前store，不缓存隐藏真实变更。明确当前可见已读页可复用，但不以reused标记冒充模型轮数减少，不省略任务全文核验。
- 第四/五轮真实模型证明仅说明“必须填topicId”仍会产生同批两次空调用；第五轮实际HTTP/SSE确认工具wire声明完整、提供方start.input已为空，未支持Host丢参解释。最终在route首包、相关Topic和搜索结果中提供已有summary（最多240字）及逐候选完整readCall；缺参返回所有有界合法choices，不默选；摘要足以排除时直接路由，真正必要才读取历史。
- `onInputSettled` 从任务Topic适配器透传既有原生Topic回调；由消息服务在首次决定完成时推进来源投影，不新增通知等待门禁。

## 验证

- `node --test --test-reporter=tap test/topic-runtime.test.js`：136/136 PASS，0 skipped。覆盖缺Topic结构化拒绝、scope绑定、显式错请求、错群、旧revision、原Topic更新后拒绝；原边界和分页回归保持。
- 设置 `DSH_NATIVE_TEST_PROFILE=D:/dsh_home/profiles/web/package.json` 后运行 `node --test --test-reporter=tap test/task-topic-routing-native.test.js`：11/11 PASS，0 skipped。实际原生工具注册/执行覆盖route空参拒绝、review/Topic空参绑定、错请求拒绝及无业务Task/发送；目录预算、query续页、当前版本变更fingerprint独立覆盖。
- 原始日志：`docs/tmp/quoted-deployment-handoff/latency320/topic-runtime.log` 与 `topic-native.log`。最后增加的onInputSettled透传由总任务的来源完成计时用例联合复验。

本轮不重放#320、不发送真实消息。真实模型的无效调用数、目录重复次数和壁钟由后续同路由隔离轮次记录；上述scripted原生测试不替代真实模型性能结论。

## 最终真实模型结果

第六轮同一实际`cortex-gateway/cortex-cowork`、low、原图片隔离字节与相同27项候选：图片已准备后至语义承接32796.969ms，3次标准stream（route1、decision2），无效工具调用0、同请求同query+offset重复目录0；唯一新只读物料名称排查Task，未误接旧UPR或合并来源事项、未跨群。证据见`round-6-model.json`与`round-6-model.md`。第四/第五轮失败保留，不覆盖；不是受控现场提速对照，也不保证任意未来模型首稿零错。

最终模板后`topic-runtime`仍为136/136 PASS。关联原生整文件同时包含总任务新source时钟用例，曾出现10 PASS/1 FAIL/1 cancelled（timeout）；不把早先11/11当成最终整组全绿，由总任务在其即时源戳修复后统一重跑。SG6新原生bound-read/目录用例在该失败轮仍通过。
