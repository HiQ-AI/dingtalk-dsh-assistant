# 话题复用与原生失败恢复验收

本次技术修复及现场续办已通过。矩阵当前26个用例的最新轮次均PASS；旧失败、被审查拒绝的自动通用清账、夹具错误、排序反证及本轮测试契约修正保留在对应round记录，不宣称一次通过。

## 当前结果

- Web对原任务补充/重开/取消复用原话题；隐式来源版本沿当前原任务绑定，显式旧版本拒绝。取消不会越过活跃决策或其他任务的共享blocked保留项。
- 两个业务事项原来6个话题，四个旧Web重复话题按明确task/applied/action关系正式归并。当前列表2，含档案6；每条Web来源当前仅一个话题归属。旧revision1及原decision/operation完整保留。
- 原任务、13个执行会话及全部operation状态、需求/控制版本、来源/话题refs和appliedOperations独立比较不变。归并不重做意图、不创建任务、不替换会话。
- 两次指定DATABASE_NOT_FOUND经操作人明确原operation摘要，正式结算failed/partialEffectsPossible；原unknown/isError审计与实际响应/正常turn结束序号保留，不登记成功或noEffect，不重放Bytebase API。原Web技术申请answered，同execution/session输入8完成规则接口核对和部署准备，Bytebase重放数0。
- 来源时间线已修复：撤回话题9,12,13,14；描述框话题1,2,3,4,7,8,10,11。同一消息多个单元稳定，历史版本成员不变。
- 重复审批的根因已修复：执行输入仅保留最初需求人的来源，遗漏后来操作人的UAT指令；统筹/执行现均保留原始来源与最近补充、当前目标及完整目录。共享协议要求授权判断先核对后续撤销，技术回复不自动撤销旧范围；真实最后审批仍保留，未新增自动批准或未知操作清理。
- 任务详情和人工页采用相同等待层级，证据、尝试和原文可展开。原申请通过正式入口answered，原execution/session输入8→9；实际提交并快进推送9a545aa至原PR353，等待为空，unknown操作0。原业务任务继续集成和隔离验证。

## 验证与交付

前轮综合相关13文件322项及话题/路由/原生回归160项通过。本轮核心85项、Observer93项通过，strict UI audit零finding。最终Assistant SHA256为244dbbc540f9d8009623832108b6c1ed18635b5982f193ee48fd6d93bf9d3dc7，Observer为5ecaa17a21549cbcc8c1178b9f47ca0ede80582e5c8cfb4c78bd67df931775a0；双包源码/包/安装独立比对，新PID64388同时持有3080/18998，旧PID55216退出，profile未变，无历史备份，接入/DWS就绪。

真实Chrome分别点击两个话题，确认2话题、原关联任务和正确来源顺序。本轮又核验等待双页面、正确PR链接、键盘展开原文/证据以及390像素窄屏无横向溢出。PNG/AX仅本地留存，按round-18/20/24配方复现。机器可核验结果见round-24/runtime-readback.json、continuation-readback.json和business-progress-readback.json。交付沿原PR182，base main、head worktree-native-background-receipt；最终PR回读单独归档。主检出及既有未提交文件未修改。

## 边界

部署时health仍degraded：两条历史通知读回unknown及当时的业务等待。原重复审批现已纠正，任务真实继续；未重发历史通知。新提交及原PR推进有独立证据，仍不证明业务UAT发布或真实业务E2E；此前越界全仓测试的共享影响仍未核实。它们不作为本次技术验收成功项。

话题归并新增mergedInto/mergeReceipt；不能让不理解该字段的旧包重写domain。本轮上下文与呈现修订无schema迁移，回退须先排空原执行并保留当前审计，不自动重放操作。权威目标与交付检查点为同目录goal.md。

修订bf442f3已推送原PR182并更新正文；round-24/pr-readback.json独立证实OPEN、base/head和正文一致，未合并。SG1至SG4完成。
