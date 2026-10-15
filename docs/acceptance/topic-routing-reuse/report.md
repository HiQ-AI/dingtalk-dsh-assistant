# 话题复用与原生失败恢复验收

本次技术目标完成。矩阵20个用例的最新轮次均PASS；旧失败、被审查拒绝的自动通用清账、夹具错误及排序反证保留在对应round记录，不宣称一次通过。

## 当前结果

- Web对原任务补充/重开/取消复用原话题；隐式来源版本沿当前原任务绑定，显式旧版本拒绝。取消不会越过活跃决策或其他任务的共享blocked保留项。
- 两个业务事项原来6个话题，四个旧Web重复话题按明确task/applied/action关系正式归并。当前列表2，含档案6；每条Web来源当前仅一个话题归属。旧revision1及原decision/operation完整保留。
- 原任务、13个执行会话及全部operation状态、需求/控制版本、来源/话题refs和appliedOperations独立比较不变。归并不重做意图、不创建任务、不替换会话。
- 两次指定DATABASE_NOT_FOUND经操作人明确原operation摘要，正式结算failed/partialEffectsPossible；原unknown/isError审计与实际响应/正常turn结束序号保留，不登记成功或noEffect，不重放Bytebase API。原Web技术申请answered，同execution/session输入8完成规则接口核对和部署准备，Bytebase重放数0。
- 来源时间线已修复：撤回话题9,12,13,14；描述框话题1,2,3,4,7,8,10,11。同一消息多个单元稳定，历史版本成员不变。

## 验证与交付

综合相关13文件322项通过；最后话题/路由/原生回归160项通过。最终Assistant SHA256为7ed96f75702cd75fce18d2df4e0e51d016f4429c3bd5b2bfb93b18df09939c89，Observer67e1438d448db76936a233ce0d2ac7930d2c13d6fccedd2c3a02f0b8ef79136d；双包源码/包/安装独立比对，新PID55216同时持有3080/18998，profile未变，无历史备份，接入/DWS就绪。

真实Chrome分别点击两个话题，确认2话题、原关联任务和正确来源顺序。PNG/AX仅本地留存，按round-18/20配方复现；主要机器可核验结果为round-20/final-readback.json。PR182已更新，OPEN，base main、head worktree-native-background-receipt，正文独立读回相同（round-20/pr-readback.json）。主检出保持原f6d366a及既有未提交文件。

## 边界

health仍degraded：两条历史通知读回unknown，一条业务代码交付精确批准等待。本次未重发通知、未替原任务批准提交/推送/构建或业务部署，不证明业务UAT或真实业务E2E；此前越界全仓测试的共享影响仍未核实。它们不作为本次技术验收成功项。

话题归并新增mergedInto/mergeReceipt；不能让不理解该字段的旧包重写domain。排序修订可回退到90a21792受控包，无需重建历史数据。权威目标为同目录goal.md，当前SG3完成，状态COMPLETE。
