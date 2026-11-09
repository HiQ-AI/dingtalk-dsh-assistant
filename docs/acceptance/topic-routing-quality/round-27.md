# 第27轮：关闭普通私聊消息接入

日期：2026-11-09

## 范围与结论

用户要求先关闭普通私聊消息接入。引入点已核实为2026-11-07T04:49:55+08:00的提交`442347ff`，PR #348于2026-11-07T01:02:08Z合并；此前all-direct通道只负责人工答复，该提交新增了普通私聊首筛与自动历史补拉。

本轮移除普通私聊向业务首筛的转交、自动历史补拉及断线补偿；已登记私聊不再参与群消息桥接健康或群接入恢复完成判据。保留原审批/技术介入的真实会话、作者与引用核验，保留群消息实时/补拉、历史会话、Task、通知及未确认效果，不删除业务数据或取消原任务。不增加配置开关。

## 源码与验证

分支`worktree-disable-direct-ingress`基于最新`origin/main=3da4d86b464f000d104bab39ba7d2df3e52eeff3`。实际验证绑定未提交源码：bridge blob `602b773f313b13de766f37ebf5a0600a0c4ebcd9`、test blob `5ee3d2dde7a0ab6d9bd8df7ec6265276ae175628`。原有goal/matrix/round-25/round-26、停机证据及未知stackdump保留，不纳入本次产品改动。

- 修改前同一关闭合同回归：0/1，实际收到1条普通私聊业务来源，预期为0。
- `node --test test/dws-bridge.test.js`：61/61，0 fail/cancel/skip，967.054ms。覆盖普通私聊不准入、既有私聊启动/周期/暂停恢复不补拉、人工通道重连后仍不准入、正确人工引用恢复、错误作者/会话/引用拒绝，及原群消息实时/补拉/暂停恢复和通知合同。
- `node scripts/test-suites.mjs check`：345文件各一次，historical5/deleted0，未变更测试映射。
- `pnpm test:release-smoke`：使用实际三包目录与本机原生profile，14/14，0 fail/cancel/skip，47591.5341ms（后台任务`bgl8w4m9c`）。个人Skill business25432ms、Resident health business7823ms，均未abort，未放宽原时限。
- 实包中的bridge和Resident源码独立逐字节匹配已测工作树。

## 候选包身份

| 包 | 字节 | SHA256 |
| --- | ---: | --- |
| dingtalk-dsh-assistant-2.3.0.tgz | 55548 | c1fbc6db94d0d471ca1fbdf4cc1635157649f6288b06f8c58b1cf09a4ebcd8e7 |
| zzusp-dingtalk-dsh-assistant-2.3.0.tgz | 550321 | b437d0e31a71bfcf70e21ff6b5584493f13c21078c22a8744c5cb15ac24bc2bb |
| zzusp-dingtalk-dsh-observer-2.3.0.tgz | 62783 | d147a380d7e982e4a66280d65f024628ee2759118e53bca2718db3479dad961f |

三包由上述冻结源码分别使用pnpm pack生成于`docs/tmp/disable-direct-ingress-packages/`；Observer未变。本轮同时带上已合并#349来源关联查询接线，未重写该修复。

## 本机应用

待合并后按原生双包runbook应用并独立核验包摘要、安装版本、新PID、双端口、桥接健康与普通私聊入口。部署前原安装PID98756、桥接健康、3个会话含1个direct；current-control仅为候选排空证明（tasks/executions/groups均0、unknownOperations3/unknownNotifications1），不当作原子停机或业务完成。

未发送真实钉钉消息、未重放历史、未手改SQLite、未重发未知通知，未触发CI或tag。真实钉钉渠道验收未执行。
