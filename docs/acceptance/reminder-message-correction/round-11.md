# 第 11 轮：引用优化后的剩余串行处理

用户再次在测试群复测“部署验收1024D”，指出仍慢。本轮第二条实际包含原生引用，预载确实命中；没有模型连接失败或补读。因此不能再用上一轮网络重试解释本轮延迟。

## 真实基线

| 项目 | 北京时间/耗时 |
|---|---|
| 首次指令 | 19:26:34 |
| 安排确认 | 19:27:03，29 秒可见 |
| 引用订正“提前2分钟” | 19:27:21 |
| 改期确认 | 19:27:46，25 秒可见 |
| 订正后计划 | 19:29:34 |
| 实际提醒 | 19:29:39，晚 5 秒 |

到期仍仅发送一次；原生“@我”查询 complete=true/failedCount=0，精确命中提醒，完整群窗口到 19:37:21 仍为两输入、两确认、一提醒共 5 条，原时刻 19:31:34 没有重复提醒。

订正分段：消息发生到首请求 7.934 秒；话题归类模型 10.476 秒；交接 0.583 秒；提醒规划模型 4.833 秒；冻结 0.070 秒；出站等待 0.058 秒；发送到 ACK 1.208 秒；ACK 后回读 1.366 秒。两层模型串行共 15.309 秒，0 重试、0 context_get、0 消息补读；路由预载引用存在，规划目录均 deferred、已有安排详情 1 项。输入 tokens：归类 11,038、规划 17,692。真实证据 live-e-model-analysis.json、live-e-1.json、dws-e-window-final.json、dws-e-at-me.json。

## 本轮改进范围

复用已有精确引用验证、wholeMessage 单元预留、所有权和拒绝交还机制，让单条明确引用的提醒先进入协调模型；模型仍判断整条语义，不能单提案完整覆盖或包含需新建普通任务的混合事项须在任何效果前交回原路由。已交还的同来源版本不能重新捕获，保留版本、关闭、禁用、冻结、重启和未知效果边界。实现前置快照见 docs/spec/reminder-direct-followup.md。

前 7.934 秒尚不能在消息级账本内细分。19:37:36 只读采样确认三个原生 consumer 均为 received=0/dropped=0，目标群无 lastEventAt，运行时实际依靠 10 秒历史补拉。DWS v1.0.63 文档说明自身消息过滤，当前登录账号和来源均为孙鹏；通讯录结果未返回 openDingTalkId，精确身份映射不由昵称推定。现有 CLI 没有接收自身事件开关，不能通过配置修复；缺少当次补拉历史和 Host 首次接收时间，不能声称已精确拆分轮询等待。证据 inbound-transport-evidence.json。未改外部包、模型、网络或轮询配置。

## 实现与定向验证

精确引用入口使用原有 `routeMessages` 原子保留完整来源，`requireAllPending` 仅由此 Host 入口传入，在同一事务核对未路由消息 ID/版本集合。并发新入站、目标版本变化、另一条旧消息富化均拒绝旧候选。已存在来源归属或交还历史不再捕获；无新状态表或提案协议。

- `node --test test/independent-coordination-changes.test.js test/topic-store.test.js`：84/84 通过。
- 使用实际原生测试 profile 运行 `test/independent-coordination-changes-native.test.js`：11/11 通过，0 skip；三种引用动作不再调用归类模型，A 改期保持 B，明确改 C/另建给 C 可按需读取；混合事项无效果交还后拆分，恢复不重复。
- 独立审查通过；补充的三类提交竞态均在最终提交入口注入验证。`git diff --check` 通过。测试记录原存 docs/tmp/reminder-direct-followup-tests.log 和 reminder-direct-followup-native-tests.log，本轮复制归档保存。

真实 gpt-6-astra/low 隔离模型两例均首跑通过：A 改提醒 B 为 1 次模型、0 补读/重试、6.587 秒模型耗时，17:57→17:54 且保留 B；“提前三分钟，并修复导出报错”为 1 次模型、0 补读/重试、7.291 秒，唯一提案为 reject，未先修改提醒。使用生产规划器与实际时间插件，仅捕获提案，未接业务库或发送器。原生日志、输入、结果在 model-evaluation/direct-retime 和 mixed-reject；规划器摘要独立核对一致。

发布冒烟首次 13/14 通过，失败为本分支之前新增发送测试导入后漏更新 suite-map。按现有脚本重新生成并语义比对：303 个文件及全部 release 标志不变；仅 coordination-schedule-revisions 从 unit 归到 compat，新增实际 dws-adapter/notification-delivery 导入，顺序分组导致 185 项 lane 变化；没有退出门禁或删除测试。映射修正后仅复跑相关 release-workflow 8/8 通过，其余首次通过的包运行/产物测试无代码变化。原失败记录 release-smoke.log 和复跑 release-mapping-recheck.log 均保留。

## 部署

544c32a 已推送 PR #255，状态独立回读 OPEN。部署零写预检确认 59 个原生会话已排空，未开始领取为空，unknown 操作/通知均为 0；按原 runbook 双包安装，未改 profile 或数据。19:56:15 独立回读：新 PID 52212（19:54:32 创建）拥有 3080/18998，双包版本 2.1.0，health=ok、恢复问题 0、入站和 DWS 健康、匿名 Web=401。

Assistant 持久包位于 D:/dsh_home/packages/544c32a-reminder-direct，382,985 字节，SHA256 604575196B5AFEE011219592F5E7E3DF6CA95885EDECE7D5DD347ABA9BA4614D；Observer 52,806 字节，SHA256 88A51BE3B4D532DA19740620512DAA26C7C36E377A550563BA660ACA06A61396。profile SHA256 74FE100C0019F5E4C76C06903FDB622B0AF5696AFC60AB38CBD252CE8F948499 未变。证据 deployment/、deployment-independent.json。

目前证明代码路径省去归类调用且部署正常；新的群内总耗时仍待用户客户端验收，继续保留线上性能 FAIL。原 E 已结束，不能用它验证活动提醒快速改期；已请求在同一授权测试群创建 F 后引用确认提前一分钟，不重新询问群或日期。
