# 阶段授权来源候选纠正

现场候选已正确关联话题并表达开发交办，但 stageAuthorizations.sourceQuote 是“按文档开发”，objective 改写为扩展业务描述。Host 正确拒绝不属于逐字来源的授权片段，错误反馈却没有解释字段约束，也未进入协调器同轮纠正分支。

保留原来源绑定和逐字校验。区分 arguments.objective（完整业务目标）与 stageAuthorizations.objective（逐字授权证据），提示模型按当前来源修正，Host 不自动改写或补授权。原生提交收到此合同错误时返回 received:false 及具体反馈，由同一轮重新提交；不能转成用户澄清。测试覆盖错误后零业务效果、正确候选唯一Task及其他来源/作者反例。部署后复用原 pending 消息，禁止再造 replay 或直接写账。
