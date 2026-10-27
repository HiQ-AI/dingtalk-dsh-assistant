# 真实模型第三轮：引用承接与重复派发保护

## 结果

两场景PASS。使用修复后的生产独立协调planner与context、既有`cortex-gateway/cortex-cowork`、high；实际27项合成目录的目标位于第27项，其中另有相似终审UPR任务作为反例。两个场景均真实调用分页和目标全文读取，没有向用户重复索取PR。

| 场景 | 最终模型提案 | 耗时 | 标准stream数 |
| --- | --- | --- | --- |
| 原任务当时已完成PR交付、未部署 | `arrangement`，唯一原Task的`task-reopen/replan`；明确后端417、前端389、UAT2及原验证边界 | 19636ms | 3 |
| 当前原Task已active并承接同一PR的UAT2部署 | `arrangement`，唯一原Task的`task-observe`；成员无context/objective/requirements/progressImpact，不重复重开或派发 | 36560ms | 4 |

第二场景首次提交混入了resolve分支字段，被生产Zod严格拒绝；同一原生回合随后自行纠正为合法arrangement。该拒绝未产生捕获提交或业务效果，最终通过不表示每次模型首稿总会合法。

## 工具契约证据

生产工具现在暴露对象根`type/properties/required`，`kind`为公共必填；模型实际取得kind、members、question等字段。完整分支约束继续由执行时Zod核验，前述错误字段被拒绝正是实际反例。没有手填提案、换模型或更改提供方strict设置。

小结果与源码SHA256绑定见`round-3-model.json`；原始输入、提案和原生日志在忽略目录`docs/tmp/quoted-deployment-handoff/model-round-3/`。再生成：

```powershell
node docs/acceptance/quoted-deployment-handoff/scripts/verify-real-model.mjs docs/tmp/quoted-deployment-handoff/model-round-3-rerun
```

## 边界

submit仅捕获、上下文是去身份合成副本，未连接真实TaskStore或钉钉渠道；本轮真实渠道发送和真实业务写均为0。既有官方凭据服务仅只读加载，文件前后SHA256一致；没有新登录、复制凭据或修改长期配置。7次标准stream不等于7次网络请求：提供方内部重试、费用未知。

当前现场原任务已active，与原消息当时的completed状态不同；不得据第一场景对现场再次reopen。真实 #313 的受控恢复、来源绑定以及安装后看板读回仍须独立验证，不能由本隔离语言验收替代。
