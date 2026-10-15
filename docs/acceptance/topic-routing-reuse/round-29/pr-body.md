## 问题与结果

原生后台服务曾一直等待进程退出，真实失败响应留在unknown，Web补充已有任务又重复建话题。技术恢复后，任务遗漏后来操作人的授权，继而把已交办的UAT部署拆成多段批准；每个工具结果还会唤醒统筹，重复注入约59.6KB快照。

本PR保留原job/operation/task/session，恢复真实收据及原话题复用，修正申请前授权判断，并将普通工具回执交由原执行消费。现场原任务已完成UAT发布，原申请answered，没有再索取同一部署批准；插件修复已部署本地。UAT流水线自动重启失败，原执行复用成功镜像完成精确更新和运行验证，保留流水线整体killed事实。

## 实现

- `packages/dingtalk-dsh-assistant/dynamic-native-job.js`、`dynamic-process-scope.js`、`execution-session.js`：显式后台返回原job running回执；排空停止所属服务并记录真实终态，前台提升仍等终态。
- `dynamic-operation-readback.js:42`、`dynamic-task-store.js:391`：按原错误/摘要/正常turn/排空/绑定调查核验失败；操作人指定原operation摘要后，失败结算与答复单事务。保留partialEffectsPossible，不自动清unknown或伪造noEffect。
- `store.js:736`、`topic-model.js:32`：Web补充/重开/取消复用原话题；旧重复话题按唯一task/applied/action关系归并。稳定来源顺序、历史版本和共享决策边界保留。
- `task-source-instructions.js:2`、`task-session.js:154`：统筹、执行和申请工具共享申请前判断。“部署到UAT”覆盖同一任务的实际部署，不能只做准备再索取“最终批准”；规则要求批准时先核对已有原文是否满足。后续撤销、生产/数据边界和真实原生拒绝继续有效，无Host关键词放行或自动批准。
- `model-context.js:201`：保留原始授权和最近19条来源、作者/更正、执行目标及resultRef；完整来源/任务/材料/执行按需读。短文本直接展示，终态执行移除重复阶段正文。
- `task-session.js:99`：在原生request生命周期退休旧Host快照及旧版历史标记，保留原始审计和其他任务内容。
- `dynamic-task-store.js:806`：原绑定仍当前、执行运行且未排空时，普通成功/失败不唤醒统筹；阶段、终态、unknown、对账、迟到、独立操作和巡检仍可靠唤醒。
- `packages/dingtalk-dsh-observer/web-client.js:516`：等待页突出进度与待决定事项，明细折叠，链接/键盘/窄屏可用。README和runbook同步；本机冷启动等待改为五分钟，退出排空仍两分钟。
- 合入main的PR184并解决两处冲突：保留当前目标/需求和来源授权，同时保留中文执行短名、原会话续办名称与旧英文名回退。

## 实跑与现场证据

- 前轮相关322项、话题160项、授权85项、Observer93项通过。本轮上下文/原生续办95项、唤醒/job恢复83项通过；授权协议6项及最终工具描述1项复跑通过。main合流后原生服务/名称/工作区36项及store名称2项通过。早期字段裁剪回归保留失败记录，恢复input/resultRef/body后重跑；没有主动跑全量测试。
- 精确原生日志lease178输入59587→26798 UTF-8字节，减少55%；11条来源及8项执行目录逐项一致。实际安装后的原会话surface仅1份当前Host、0历史标记。连续3个普通工具完成=0操作唤醒；合入UAT并启动构建这一阶段才唤醒统筹。
- 原生180旧标记测试65206→983字节，原审计/外任务/压缩恢复不变。32轮续办末次当前输入12874字节、旧Host基线0；正常工具与助手历史仍增长，完整adapter约499KB。55%不是token或整个请求的降幅。
- 两项DATABASE_NOT_FOUND保持原身份failed/partialEffectsPossible，Bytebase未重放；四个旧Web话题归并后当前2/含档案6，原账保留。
- 最终本地Assistant包SHA256 `9b1ce88f4e93c12611fbb8e5d615a4d8a3cbd5060d5893025c3b5b1509b60f0b`，Observer `5ecaa17a21549cbcc8c1178b9f47ca0ede80582e5c8cfb4c78bd67df931775a0`。零写Check、正常SIGINT退出、官方双包安装及包/安装核验完成；独立确认新PID43072持有3080/18998、旧PID52452退出、profile未变、接入/DWS就绪。前轮冷启动超时保留，最终五分钟等待脚本成功。
- 真实Chrome验证两话题/原任务、等待双页面、PR链接、键盘展开及390px窄屏。原execution/session输入8→9完成开发提交9a545aa和17项隔离验证；最新纠正后输入10→11继续实际UAT发布。独立gh确认PR391 MERGED、base feature/uat2-base、head a5bae0bc。
- 实际UAT独立kubectl/registry/入口核验：新镜像 `sha256:c0d744d93eec0acfadc2976732f3ee78d5cfd0390de439ee25c266bf3657ad28` 对应唯一构建289及合入提交4e2a1b56；deployment 521/521、desired/updated/ready 1/1/1，新Pod Ready、restartCount0、imageID一致，服务UP、入口HTTP200。原任务completed/执行succeeded且均排空，waiting0、unknown操作0。插件最终重启后仍lease190/输入11，没有重新部署业务。

36个技术用例最新均PASS，命令、失败反证和机器回读在`docs/acceptance/topic-routing-reuse/round-25.md`至`round-30.md`及同名目录；历史轮次保留。

## 边界与回退

真实申请撤回E2E未执行；UAT流水线构建推镜像成功、自动重启失败、整体killed，运行更新成功不等于CI全绿。旧共享测试影响及三条完成通知unknown未扩展处理，未重发或宣称送达，本地health因此仍degraded。话题新增mergedInto/mergeReceipt，旧不识别字段的包不能重写domain；其余本轮无schema迁移。回退先排空原执行并保留当前审计，不重建身份或重放效果。
