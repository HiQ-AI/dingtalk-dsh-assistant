# #320 同类图文真实模型第四轮

## 结果

FAIL：最终业务承接正确，但两次缺参调用仍存在，不能标为无效往返修复完成。实际`cortex-gateway/cortex-cowork`、low，生产独立Topic路由/决策协调器，原 #320 图片91098B的隔离附件副本、27个本群候选及一个跨群干扰候选。没有运行现场TaskStore、Owner或钉钉渠道。

图片准备后从隔离消息保存至Topic决定完成为74566.1508ms，8次标准stream（route=4、decision=4）。同一请求同query+offset的Task目录重复次数0。费用及提供方网络请求/内部重试次数未知。这不是与现场受控A/B对照，不能宣称现场已提升到该耗时；不包含原DWS图片下载。

## 实际调用与边界

- 路由第1个assistant消息（seq16/step1）并行提出两次`group_topic_context_get {}`，并非第一次拒绝后再循环。两次均收到明确`topic_id_required`，没有被Host默填为任一Topic。
- 随后模型正确带topicId/revision分别读取“终审只读UPR导入覆盖”和“合并来源展示”历史，排除它们，创建独立的物料名称显示排查Topic。
- 决策读取精确查询目录、`group_reply_review_get {}`、全群目录后提交。绑定review空参数已一次成功；两次Task列表查询条件不同，没有同页无依据重读。
- 最终只有一项`new-task`，目标为只读排查草稿导入UPR后物料名称未显示的原因，不修改代码或部署，没有误接跨群Task或重开两项旧交付。动作只在隔离适配器捕获，真实渠道发送0、真实Task写入0，凭据文件摘要未变。

小结果见`round-4-model.json`；原生日志在忽略目录`docs/tmp/quoted-deployment-handoff/latency320/model-round-4/runtime/legacy-sessions/`。

## 尚未收敛的参数丢失位置

原生request/header已有完整对象根properties/required，不能复用前轮“根oneOf被丢弃”的结论。安装pi-ai的Anthropic流处理在tool_use start接收input，但toolCall end会以partialJson重新解析覆盖arguments；完整参数仅在start出现时存在被覆盖为`{}`的可能。第四轮未侧录原始SSE，尚不能断言模型本来就生成空对象。下一轮仅采集实际wire工具schema、tool_use start.input及input_json_delta，不记录headers、图片body或reasoning事件，先证伪适配器候选，再决定是否仅需增强候选readCall可发现性。
