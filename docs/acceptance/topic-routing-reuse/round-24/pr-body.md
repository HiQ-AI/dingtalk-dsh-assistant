## 问题与结果

后台服务工具曾等待进程退出才返回，已结束的原生失败又留在unknown，阻断原执行；Web补充已有任务会重复建话题。解除技术阻塞后，执行上下文遗漏后来操作人的UAT指令，把原有授权误判为不足，再拆成多段审批。

本PR恢复原job和原生失败收据，复用原任务话题，并让统筹与执行共同核对完整授权来源、当前目标及后续撤销。等待页先显示进度和待决事项，明细可展开。现场原任务已沿同execution/session恢复，实际完成新业务提交并推进原PR353；不将此视为UAT发布完成。

## 实现

- `packages/dingtalk-dsh-assistant/dynamic-native-job.js`、`dynamic-process-scope.js`、`execution-session.js`：显式后台返回原job running收据，排空时记录真实终态；前台提升仍等待终态。固定原生job读取身份，拒绝同名写替换。
- `dynamic-operation-readback.js:42`、`dynamic-task-store.js:391`：原生isError、参数/结果摘要、正常turn结束、排空和绑定只读调查只构成失败证据，不推断无效果。受信本机Web操作人明确operation摘要后，全部失败结算与答复单事务；任何漂移整批回滚。普通模型不能自动清未知写账。
- `store.js:736`、`store.js:775`、`topic-model.js:32`：按原task/applied/action关系归并旧重复话题；Web补充、重开和取消复用原话题。旧版本/消息/决策/操作保持，活跃或多任务共享决策不能越权覆盖。
- `topic-model.js:70`：按指定revision计算归属后按source sequence稳定排序；保留历史成员及同消息多个单元顺序。
- `model-context.js:212`、`task-session-service.js:659`：原始授权及最近19条已接纳来源进入上下文，保留真实作者、当前objective/requirements和完整catalog，替代只按最初需求人筛选。新增原文正文只计一次，目录增长预算仍验证。
- `task-source-instructions.js:2`、`task-session.js:7`：统筹和执行复用同一来源解释规则。任何授权判断前核对相关原文和后续撤销；技术答复不自动撤销已有范围，最终批准不扩散到已授权准备。没有自动授权、关键词批准或unknown清理。
- `packages/dingtalk-dsh-observer/web-client.js:516`：任务详情和人工页共用等待内容组件，区分进度与待决定事项，明细折叠，支持正确链接及展示换行；路径、代码和完整原文保留。README、API、runbook和UI契约同步。

## 实跑与现场证据

- 前轮13个相关测试文件322项通过，最终话题/路由/原生回归160项通过；本轮核心7文件85项、Observer93项全部通过，strict UI audit零finding。未主动跑全量测试。
- 新回归覆盖不同操作人的UAT授权、技术回复、最新暂停、窗口外撤销目录、同task/execution/session续办，以及原有未知效果和权限门禁。32轮真实续办仍核对身份、状态与预算；稳定名称断言过期已在未改基线复现，修正测试而非产品逻辑。
- 两次指定DATABASE_NOT_FOUND原operation已正式failed/partialEffectsPossible，previousObservation及原始日志序号保留，未记成功/noEffect，Bytebase未重放。四个旧Web话题归并后默认2、含档案6；旧revision1和原任务/操作账仍可审计。
- 最新双包已本地部署：Assistant SHA256 `244dbbc540f9d8009623832108b6c1ed18635b5982f193ee48fd6d93bf9d3dc7`；Observer `5ecaa17a21549cbcc8c1178b9f47ca0ede80582e5c8cfb4c78bd67df931775a0`。Check零写，原生退出，源码/包/安装核验，新PID64388持有3080/18998，旧PID55216退出，profile未变，接入/DWS就绪。
- 真实Chrome核验等待双页面、PR353链接、Enter展开证据/原文和390像素窄屏。抽屉389/389、正文326/326，无横向溢出；视口已恢复。
- 原human-82f82c9a申请经正式reply纠正后answered，原execution bdb7b510/session task-execution-9b11f09e输入8→9继续，等待为空、unknown操作0。独立git与gh确认新业务提交`9a545aa609bada3c02514f4892494ed6805e0b76`及原PR353 OPEN/head一致，证明实际推进。

分轮命令、失败反证和机器读回位于`docs/acceptance/topic-routing-reuse/`，本轮为round-21至24，矩阵26个用例最新状态均PASS。截图仅本地保存，round-24.md提供复现路径。

## 边界与回退

本PR不证明UAT发布、真实业务E2E、旧共享测试副作用无影响或两条历史通知送达；通知未重发。部署时health仍degraded，具体历史事项保留。原任务继续既有UAT范围，真实最终发布门槛、后续撤销和共享环境限制不变。

话题归并新增mergedInto/mergeReceipt，不能让不理解字段的旧包重写domain。本轮授权上下文及UI无schema迁移；回退先排空原执行，保留当前审计和原身份，不重建历史、不重放操作。
