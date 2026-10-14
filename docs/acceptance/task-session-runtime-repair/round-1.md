# 第一轮定位与验证

## 结论

三项均有重构接线或恢复缺口，不能笼统称原机制代码全丢。

1. 本人补拉仍在DWS group backfill；新入口按assistantActorId一刀切拒绝本人手动消息。自身通知识别后仍写群history且UI不过滤，导致收信箱出现通知。已改为统一精确通知判定，正常本人消息接纳；history保留，视图过滤。
2. 新通知回读硬性要求DWS未提供的原生mention元数据。真实query-send-status成功及mget原生引用/正文/发送者核验通过。新proof区分delivery和mentionVerification=unavailable，不从文本@推断mention；错元数据仍拒绝，无精确回执的历史匹配仍严格。
3. recover只kick但原任务wait已消费所有wake。启动快照中的技术unknown等待按源码实现摘要+需求/控制版本生成一次持久wake；相同代码重复定时恢复/重启不再唤醒，unknown fence原样保留。

## 证据

- 现场原Task active/drained，lastDecision=wait，无question，原pwsh operation unknown。原生tool/result明确旧Host停止并排空，不证明git fetch成功。
- 真实DWS原通知status SUCCESS，消息ID与原群一致；原生引用及完整正文和发送者一致。DWS原始list-by-ids亦无原生mention字段。只读新回读返回identity=send-receipt、mentionVerification=unavailable；未写live账。
- test-round-5.log：127/127，0skip。
- test-round-6.log：5/5，0skip，含早于ACK回声、本人补拉、一次重启唤醒及两项unknown fence。
- test-package.log：2/2，真实npm tarball解压后任务与resident运行。
- test-round-3.log：149中147通过；仅两项旧unknown夹具失败。经改为现有Topic工具和明确交办文本，test-unknown-round-4.log 3/3，再于round6 5/5复验。相关service native19项均通过。

## 未完成

待受控部署、安装摘要/新进程/健康及原任务继续对账。真实mention是否成功不可从当前读取接口证明；记录此能力边界。

## 追加：群职责与署名

现场原生群会话session-coordination-cbfd30db8ab31b7de85062b8-0ab7dab9的tool/call seq36明确提交带末尾代回署名的reply；实际通知payload缺该尾段。GET /state/agent-config的replySignature为空。根因为formatter在全局签名为空时仍删除模型署名，不是群职责未加载。

用户明确：群职责只属于群会话，不应注入任务统筹。曾加入的两处传递已完全撤回，task-session.js无diff。新增真实native模型请求测试证明群职责在群请求system中、在任务system中不存在，且通知保留群回复署名（test-group-scope-round-9.log 1/1）。不同群模型署名与无默认署名、格式完整性测试通过；设置文案和生成bundle已同步，client/build/formatter 23/23（test-client-round-8.log），通知/formatter合计43/43（test-signature-round-7.log）。历史已发送正文不重写或补发。

## 第二轮现场暴露的恢复材料缺口

首轮安装后原通知已delivered、收信箱剔除原通知、原任务lease由10推进到11并委派真实只读执行。该执行仍看见pwsh，尝试git/gh被readonly门禁拒绝，且input未提供原命令，导致再次等待；此时health仅剩原unknown操作告警，不能声称已全部恢复。

修复为只展示已绑定read/pure工具及submit，并给核查input提供经原session身份、lease/inputDigest、callId、参数摘要与结果摘要校验的originalOperation。该材料只用于定位调查对象，不能证明成功或无部分效果；Host对账仍需实际只读观察，unknown不绕过。

用户追加删除任务详情的整个需求与控制区，已删除对应组件与调用；保留独立新建表单及后端API。Observer相关41/41通过；两个包下轮一起安装。
