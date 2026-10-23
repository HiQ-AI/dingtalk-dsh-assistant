# 第 9 轮：复用原生引用回复

第 8 轮真实 C 验收未通过，不能以命令编译或打包测试代替真实 CLI 合同。用户明确要求参考任务回复，直接引用对应原消息，收敛实现范围。

## 已确定的问题与修复范围

1. 普通发送虽传递原生提及 ID，但当前 CLI 还要求传输内容包含 `<@openDingTalkId>` 占位符。C 的提醒在本地 CLI validation 阶段退出 3、stdout 为空，没有 ACK/消息回执；持久态仍为 unknown。既有引用回复 leaf 能自动补齐，提醒冻结时应绑定可信来源的 messageId/actorId，直接复用现有回复路径。正文保持业务文字，CLI 原生编码不等于向用户展示 ID。
2. 改期后的恢复查询误用不存在的 `coordination.schedule.get`。改用已有 schedule.list，真实 SQLite 重启测试覆盖已有冻结确认与变更已接纳、确认未准备两种情况，不改写原通知。
3. 仅对 C 已观察的精确 CLI 拒绝合同沿现有 reconcile 结清 failed；未知发送、其他错误或身份证据不完整仍保留 unknown，不重放 C。
4. 已送达通知在异步扫描间隙被旧 starting 快照重复回读，留下过期告警。刷新已有缓存状态、只清理已证实送达后的同类回读告警，保留原诊断和撤回失败；不额外扫描历史库。

真实 CLI `--dry-run`、定向回归、包验证、受控部署、真实原生引用与 @ 分别留证，不再只以 flag 存在推断可发送。

## 定向结果

- 适配、来源引用及回读相关 73/73 通过；新增最新订正来源、已冻结通知不改写及原生渲染后仍严格比较业务正文断言。真实 CLI 普通/引用两路 exit=0、dry_run=true、executed=false，引用 leaf 自动编码提及。证据仍保留在发现问题的 `round-8/dws-native-mention-dry-run.json` 与 `mention-reply-regression.log`。
- 恢复查询先以真实 SQLite 重启复现不存在查询两次，再修改；changes/recovery 68/68 通过，原冻结 payload/digest 不变、变更已接纳但丢 ACK 的通知只补一次。
- 唯一尝试负回执、投递及扫描相关 37/37 通过。16 类证据缺失或不匹配反例不能结清；真实 C 快照只读匹配成功，发送/回读/业务写入均为 0。竞态回归证明不再用旧 starting 快照多余回读；已送达后的过期回读告警可消除，撤回失败仍保留。

- 实际打包加载测试 2/2 通过、0 跳过，总耗时 20.437 秒；使用 test/fixtures/native-profile/package.json，覆盖 Task 与 Resident 原生装载。证据：round-9/package-native.log。


## 收件人与设置者

用户澄清提醒可能由 A 设置、到期提醒 B。当前 payload.actorId/sourceMessageId 仅确定被引用来源；atOpenDingTalkIds 独立取日程保存的 recipientIds，不回退到设置者。真实 CLI 不发送校验使用 A≠B：引用作者 A、提及列表仅 B、传输内容仅含 B 的原生占位符，executed=false。见 round-9/dws-quoted-recipient-dry-run.json；这不代替真实 B 客户端送达。

## 本地部署与恢复

a1b5785 已安装。初次安装后检查失败：打包后同一开发检出继续编辑，当前源码与冻结包不再一致。旧进程已沿 SIGINT 排空，双包已经安装；未重复安装或强制重启。随后以 git archive a1b5785 的不可变源码独立核对 Assistant 67 文件、Observer 4 文件与冻结包、实际安装内容全部一致，确认旧 PID 退出、端口关闭、账本排空与 profile 不变，再继续既有计划任务启动阶段。原失败 evidence 保留在 deployment/failure.json，恢复前证明在 deployment/recovery-check.json。

18:26:56 独立回读新 PID 31628 同时持有 3080/18998，health=ok、recoveryIssueCount=0、DWS healthy、入站启用，匿名 Web=401，profile 未改变。Assistant SHA256 57910c8395fdd337cc29a70dd4dec65dbfad717ace91529e10970a3c1611cd10，Observer SHA256 88a51be3b4d532da19740620512daa26c7c36e377a550563ba660aca06a61396。见 independent-deployment-readback.json。

C 原到期通知正式结清 failed，sendAttemptCount 仍为 1，无重发；两条已送达确认各一次发送。状态变化后自动产生一条简洁失败摘要并送达，平台原生“@我”查询完整返回且命中该新消息，真实显示 @孙鹏。items/messages 为同一结果的两个别名，按 messageId 去重后只有一条，不能算两次。该证据证明新普通通知的原生提及，不证明原 C 到期提醒成功。证据 live-c-after-restart.json、mentions-after.json。
