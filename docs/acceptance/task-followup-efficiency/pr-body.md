## 问题与结果

等待实施确认期间，任务会话虽然能收到事实追问，但 `wait` 只有内部决定，没有直接回复出口；长会话也可能继续使用旧技能。此次复用原有只读复核、可靠通知和原生技能服务，使追问可以直接得到事实答复，同时保留原确认申请和已有操作结果。

## 实现

- `task_session_submit.decision.replySourceId` 仅用于当前 `humanReview + wait`，必须有事实依据。Host 引用原追问并原生提及作者，只外发简洁 `summary`，证据留内部；不解除原问题、不续办旧执行。通知与处理记录原子落账，重复恢复不会重发。
- 多来源积压时，已答来源去重，含未答来源的原唤醒继续处理；无关消息正常消费，避免漏答或空转。
- 任务及 DSH 原生执行共用 `session-skill-refresh.js`：记录成功读取及对应原生 callId，恢复时核对成功结果，变化通过下一模型步骤的原生运行上下文提示。正文只在恢复或 provider 变化时检查，普通步骤不重复加载；引用只检查已读文件元数据。同名替换、观察失败和换根均有边界处理。
- 统筹指引补上关联任务已实施/未实施区分及精确剩余交付。实际安装的 `business-development` 三个既有文件已补阶段重读、低成本检查/夹具冒烟、失败分类和里程碑收尾；本仓库仅保存补丁及验证记录，不打包个人技能，未新增 skill 或脚本。

## 关键实现

`packages/dingtalk-dsh-assistant/dynamic-task-store.js:813`

```js
if (partialReply && item.payload?.humanRequestId === request.requestId && item.payload.sourceIds?.some(sourceId => !replied.has(sourceId))) {
  remaining.push(id); continue
}
```

只有已经处理完的来源才确认消费，避免一条答复吞掉同轮其他追问。

`packages/dingtalk-dsh-assistant/session-skill-refresh.js:48`

```js
// result 观察先于宿主落盘；只有对应原生成功结果也存在才恢复版本基线。
if (successful.has(event.data.source.callId)) remember(event.data.source.record)
else legacy.add(event.data.source.record.name)
```

崩溃发生在摘要保存后、原生结果落盘前时，只提示重新核对，不能把不完整记录当作已读新版。

## 验证

- [x] `node --test test/dynamic-task-store.test.js`：121/121；覆盖来源/租约/引用/提及/版本校验、原子恢复及两种多来源形态。
- [x] `node --test test/session-skill-refresh.test.js`：6/6；覆盖二十个普通步骤不重读正文、变更触发、换根、观察故障、旧会话、同名替换和崩溃窗口。
- [x] 原生定向追问 3/3：两条积压通知分别送达并独立回读，无关来源仅处理一次，原申请保持待答。
- [x] 原生定向技能 2/2：实际 `skill/read`、规则及引用更新、同一执行会话续办和历史保留。
- [x] 实际 skill 三文件 SHA 回读、结构校验、九个引用校验，以及四个独立只读场景评估通过；两个原脚本 SHA 未变。
- [x] 最终相关原生/打包 24 项均取得通过证据：整组 23 通过、1 项实际打包用例触及原有 30 秒时限；同候选单独复验 1/1，11.12 秒通过。原失败日志保留，未改超时或断言。实际 tarball 的文件字节、导入闭包、个人技能任务、Resident 启动和 `/health` 均已验证。
- [x] `node scripts/test-suites.mjs check`：309 个文件无遗漏/重复，原三份历史分类不变；源码及说明文档的 `git diff --check` 通过。原始日志和补丁保持字节及格式，未为去掉输出空白而改写。
- [ ] 未部署、未发送真实钉钉消息、未测真实模型语义准确率或线上端到端耗时；本轮没有运行 CI。

## 风险与边界

新字段可选，普通 wait 和真正人工答复沿原合同，无新增表或公开写 API。技能观察仅覆盖 DSH 原生 `skill/read`；Shell 自行读附件不自动跟踪。未开启 provider 监听时，外部改动入口需等恢复或 provider 事件，阶段切换仍要求按需重读。观察摘要不替代原始工具结果，不构成业务授权。

证据索引：`docs/acceptance/task-followup-efficiency/`。确定性原生宿主测试证明工具、存储与通知链路，不冒充真实群聊验收或性能提升。回滚插件提交会停用新增回复/更新提示，已有原生结果与通知记录保留；已安装个人 skill 的独立补丁和原始 SHA 在同目录保留。
