# 话题复用与原生失败恢复验收

本次技术修复及现场续办已通过。矩阵当前36个用例的最新轮次均PASS；旧失败、被审查拒绝的自动通用清账、夹具错误、排序反证、投影字段回归及冷启动超时保留在对应round记录，不宣称一次通过。业务UAT发布另有实际运行证据，不以本技术矩阵替代。

## 当前结果

- Web对原任务补充/重开/取消复用原话题；隐式来源版本沿当前原任务绑定，显式旧版本拒绝。取消不会越过活跃决策或其他任务的共享blocked保留项。
- 两个业务事项原来6个话题，四个旧Web重复话题按明确task/applied/action关系正式归并。当前列表2，含档案6；每条Web来源当前仅一个话题归属。旧revision1及原decision/operation完整保留。
- 原任务、13个执行会话及全部operation状态、需求/控制版本、来源/话题refs和appliedOperations独立比较不变。归并不重做意图、不创建任务、不替换会话。
- 两次指定DATABASE_NOT_FOUND经操作人明确原operation摘要，正式结算failed/partialEffectsPossible；原unknown/isError审计与实际响应/正常turn结束序号保留，不登记成功或noEffect，不重放Bytebase API。原Web技术申请answered，同execution/session输入8完成规则接口核对和部署准备，Bytebase重放数0。
- 来源时间线已修复：撤回话题9,12,13,14；描述框话题1,2,3,4,7,8,10,11。同一消息多个单元稳定，历史版本成员不变。
- 重复审批的根因已修复：执行输入仅保留最初需求人的来源，遗漏后来操作人的UAT指令；统筹/执行现均保留原始来源与最近补充、当前目标及完整目录。共享协议要求授权判断先核对后续撤销，技术回复不自动撤销旧范围；真实最后审批仍保留，未新增自动批准或未知操作清理。
- 任务详情和人工页采用相同等待层级，证据、尝试和原文可展开。第一次纠正后原execution/session输入8→9，实际提交并快进推送9a545aa至原PR353；但后续仍申请最终发布，授权修复当时未覆盖完整目标。本轮共享规则和申请工具明确“部署到UAT”覆盖同一实际部署，不能把“需批准”直接当作“尚未批准”。最新用户纠正通过原申请正式reply，输入9→10→11，实际合入UAT PR391并复用唯一构建289产物完成发布；原任务completed/原执行succeeded且均已排空，待答0、unknown操作0。
- 同一现场原生输入59587→26798字节，减少55%；11条来源及8执行完整目录精确可读。实际原生日志surface仅保留1份当前Host、0旧历史标记，原始审计不删。原执行连续3个普通工具完成产生0次operation唤醒；合入UAT和启动构建的阶段成果才唤醒统筹。恢复、unknown、迟到、独立操作及十分钟巡检保留。

## 验证与交付

前轮综合相关13文件322项、话题/路由160项、授权85项和Observer93项通过，strict UI audit零finding。本轮上下文及原生续办95项、唤醒及job恢复83项通过，授权原生6项及最终申请描述1项复跑通过。合入main的PR184后，原生服务、中文短名、工作区和旧英文名兼容共38项通过。实际脚本化原生32轮证明来源、恢复及原身份保留；模型语义由现场PR391真实发布补证。

最终Assistant SHA256为9b1ce88f4e93c12611fbb8e5d615a4d8a3cbd5060d5893025c3b5b1509b60f0b，Observer为5ecaa17a21549cbcc8c1178b9f47ca0ede80582e5c8cfb4c78bd67df931775a0。包/安装核验，新PID43072持有3080/18998，旧PID52452退出，profile不变，无历史备份，接入/DWS就绪。前轮两分钟冷启动等待超时后，同一进程自然就绪，未重装；启动等待修为五分钟，退出排空仍两分钟。最终合流新包按零写Check及正式脚本部署成功，独立读回见round-30；原完成任务的lease190/输入11不变。

业务UAT独立kubectl及入口读回：deployment generation/observedGeneration为521/521，desired/updated/ready为1/1/1，Pod dataset-69c84cbf79-qjp82 Ready=True、restartCount0，imageID为sha256:c0d744d93eec0acfadc2976732f3ee78d5cfd0390de439ee25c266bf3657ad28，服务健康UP、入口HTTP200。registry精确镜像与唯一流水线289/提交4e2a1b56对应。流水线构建推镜像成功、自动重启失败，整体killed；原执行复用成功产物完成精确镜像更新与验证，未冒充CI全绿。

真实Chrome分别点击两个话题，确认2话题、原关联任务和正确来源顺序。本轮又核验等待双页面、正确PR链接、键盘展开原文/证据以及390像素窄屏无横向溢出。PNG/AX仅本地留存，按round-18/20/24配方复现。机器可核验结果见round-24/runtime-readback.json、continuation-readback.json和business-progress-readback.json。交付沿原PR182，base main、head worktree-native-background-receipt；最终PR回读单独归档。主检出及既有未提交文件未修改。

## 边界

部署时health仍degraded：三条完成通知读回unknown，包含两条历史通知和本次任务完成通知，未重发或宣称送达。原重复审批现已纠正，UAT部署和运行核验完成；真实申请撤回E2E未执行。此前越界全仓测试的共享影响仍未核实。它们不作为本次技术验收成功项。

55%仅为相同Host输入的UTF-8字节比较，不是token或完整请求降幅。32轮末次旧Host基线为0，但正常工具和助手messages约480KB、完整adapter约499KB，仍由原生压缩管理，不能宣称长期总上下文恒定。

话题归并新增mergedInto/mergeReceipt；不能让不理解该字段的旧包重写domain。本轮上下文与呈现修订无schema迁移，回退须先排空原执行并保留当前审计，不自动重放操作。权威目标与交付检查点为同目录goal.md。

合流修订ce1b929已推送原PR182，round-30独立回读OPEN/MERGEABLE/CLEAN、正文一致，检查列表为空。全部子目标完成，代码中的申请前判断、安装后的输入和原任务实际发布各有独立证据。
