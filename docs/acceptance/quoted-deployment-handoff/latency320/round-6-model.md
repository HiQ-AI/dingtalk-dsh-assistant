# 第六轮：生产Topic承接链真实模型通过

## 结果

PASS。同一实际`cortex-gateway/cortex-cowork`、low，原#320图片的91098B隔离附件副本，27项本群候选（含相似旧UPR覆盖/合并来源事项）与一个跨群干扰候选。生产路由与决策协调器执行严格来源/Topic/动作校验；只在隔离ResidentStore承接，不运行真实Owner或业务。

| 度量 | 实际结果 |
| --- | --- |
| 图片准备后至语义承接壁钟 | 32796.969ms |
| route原生回合 | 14655ms，1次标准stream |
| decision原生回合 | 17761ms，2次标准stream |
| 无效工具调用 | 0 |
| 同请求、同query+offset重复Task目录 | 0 |
| 实际工具调用 | route_submit；同批task_list{}和reply_review_get{}；decision_submit |
| 承接结果 | 唯一new-task，只读排查草稿导入UPR后物料名称显示异常 |
| 真实渠道发送/真实TaskStore写入 | 0 / 0 |

路由利用候选已有摘要排除不同业务目标，没有为了UPR词面相近强读两个历史；决策读取本群当前Task目录，绑定review空参数成功，明确只读排查和报告，不修改代码/部署。没有错接两项旧交付、跨群任务或重复创建Task。工具wire仍保留实际对象根properties及required字段；没有替模型填入参数。

最小脱敏结果、关键wire根字段和加载源码SHA256见`round-6-model.json`；已独立与原始工具记录核对，task_list{}与reply_review_get{}的`argumentFields`均为`[]`。完整工具SSE与原生会话在忽略目录`docs/tmp/quoted-deployment-handoff/latency320/model-round-6/`。官方credentials-local只读加载既有引用，凭据文件摘要未变；未登录、复制凭据或改长期配置。

## 复现与限制

```powershell
node docs/acceptance/quoted-deployment-handoff/scripts/verify-topic-admission-model.mjs docs/tmp/quoted-deployment-handoff/latency320/model-rerun
```

脚本使用当前安装原生profile依赖与固定同路由，输入为明确只读排查的去身份等价文本及原图；捕获语义动作，禁止scripted模型代答。开始计时前图片已保存，不含#320原DWS图片下载及135s入站等待；本轮不证明正式实例提速或已部署。第四/第五轮失败保留，模型/网关负载可能影响壁钟，不能用单次差值声称受控性能提升。标准stream共3次，提供方内部网络/重试及费用未知。
