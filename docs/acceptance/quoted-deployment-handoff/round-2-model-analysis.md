# 真实模型第二轮：工具声明丢失联合根字段

## 结果

FAIL，不能据此声称原消息正确承接。使用既有 `cortex-gateway/cortex-cowork`、high，生产独立协调 planner/context，27项合成目录；submit仅捕获，没有连接真实任务库或渠道。120057ms内进入8次标准stream；提供方内部网络重试和费用未知。该轮首个completed场景未完成，因此当时脚本按首错停止，active场景未执行。小结果见 `round-2-model.json`，原生日志保存在忽略目录 `docs/tmp/quoted-deployment-handoff/model-round-2/runtime/legacy-sessions/`。

## 可核验的最小链

- 实际模型先调用 `coordination_context_get {offset:20,limit:20}`，再按目标ID读取完整Task，说明引用已进入模型且任务定位已推进。
- 随后5次 `coordination_submit` 的原生 assistant tool-call block、stream tool-call-chunks（`args:["{}"]`）和tool/call均为 `{}`；每次被Zod拒绝为缺少 `kind` 的invalid_union，没有成功提案或业务效果。
- 原生request/header中该工具的parameters根键仅有`oneOf`，9个分支各自有kind常量，但根没有properties/required。
- 当前安装 `@earendil-works/pi-ai@1.2.0` 的 `dist/api/anthropic-messages.js:1302`—`1317`：非strict路径仅构造 `input_schema={type:"object",properties:schema.properties??{},required:schema.required??[]}`，丢弃根oneOf。由此实际Anthropic兼容工具变成空参数对象。

## 反证与边界

不是“用户未给PR”：合成原引用与生产context中均有后端417/前端389；不是“模型没读第二页”：实际发生分页和完整目标读取。DSH消费前的标准stream也记录`{}`，不支持“DSH最后丢了有效arguments”的解释。确定缺口是非strict Anthropic工具声明丢失联合根字段；未读取或分析reasoning正文，不据此评价模型能力。

凭据通过当前官方credentials-local只读加载；未新增登录、修改配置或写凭据。凭据文件前后SHA256一致，值及原文件摘要均未输出。首次旧prompt尝试的未完成日志另保留于 `docs/tmp/quoted-deployment-handoff/model/`，不算本轮通过；该尝试在最后prompt冻结后被中止，未产生submit。

下一步修复项目工具schema投影，保留Zod执行时全约束并向非strict转换提供根字段，再以同模型对completed→reopen、已承接active→observe两场景重跑。不得手填提案或换模型制造通过。
