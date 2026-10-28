# 进度询问与协调通知全路径修复

> 状态：ACTIVE
> Goal ID：coordination-progress-notifications-20261028
> 最近维护：2026-10-28T11:29:21+08:00
> 权威目标：D:/codex/worktrees/coordination-progress-notifications/dingtalk-dsh-assistant/docs/acceptance/coordination-progress-notifications/goal.md

## 总目标
修复普通进度询问被过度解释、四个 UPR 事项协调异常，以及重复、同名混淆和矛盾的群通知。沿入站、话题、意图、任务版本、协调、执行、结算和通知追踪真实证据。

## 完成条件
- 四个指定事项和 2026-10-28 11:03:25 通知均有来源链与根因证据。
- 普通查询不修改任务、不唤醒执行、不建立持续协调；明确新要求仍可执行。
- 通知使用明确事项名称，旧观察与当前结果不混用；内部诊断改写不反复通知。
- 定向回归和必要隔离验证通过，文档及 PR 状态独立回读。

## 范围与约束
- 保留原任务、会话和效果记录，不重放已完成业务操作，不额外发群消息。
- 主检出已有修改不动；基于 origin/main@0ae6bcde 的独立 worktree。
- 已确认纯询问误建持续观察；已排除此次历史摘要递归及直接重派四任务。

## sub goal matrix
| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | 现场与全路径分析 | 四事项及重复通知完整来源链、反证和根因 | 已完成 | round-1.md、round-1-live.json |
| SG2 | 查询与协调边界修复 | 查询零业务变更，真实指令回归通过 | 已完成 | round-2.md、round-3.md |
| SG3 | 通知生成与触发修复 | 具体事项、准确状态、无无价值重复 | 已完成 | round-3.md，41项摘要测试通过 |
| SG4 | 集成验证与交付 | 定向测试、文档、PR 独立回读 | 已完成 | 302项集成及127项最终回归通过；PR #281 OPEN独立回读 |

| SG5 | 受控本地部署 | 包摘要、安装版本、新进程、健康及旧观察止扰只读核验 | 已完成 | docs/tmp/coordination-progress-deployment-20261028/ |

| SG6 | 历史错误协调正式收口 | 精确退役原纯观察安排，保留四任务及已送达，工作不再待核对 | 已完成 | round-5.md；正式revision2及错误观察已退役 |

| SG7 | 原v4 Owner模式故障恢复 | 原会话模式纠正并真实接续，原成果保留 | 已完成 | report.md；原生seq7446/7449，lease165，工具成功回包 |

| SG8 | 同类目录前置保障 | tasks根一次性权限准备并继承，新建目录不再逐项审批 | 已完成 | round-7.md；现场根及新目录原生验证 |
| SG9 | 能力判断与等待依据 | 不把未尝试能力说成不可用，保留实际失败工具/路径 | 已完成 | round-9.md；PID33984已安装 |
| SG10 | 系统回归与交付 | 各目录/恢复/续办场景正反例及现场恢复 | 部分完成 | round-7.md；额外资源组超时、提示待安装 |
| SG11 | 原发布执行权限恢复 | 原c5受信权限纠正、Git与辅助进程成功并续办剩余交付 | 已完成 | round-9.md；input9同session、原生Git提交推送成功 |

| SG12 | 本地运行看板恢复 | 索引就绪、原任务/执行保持、分页API及真实列表详情通过 | 已完成 | round-10.md；PID13436、8API200、Chrome截图 |

## 当前检查点
- 当前子目标：SG12 已完成，本地看板真实恢复
- 唯一下一步：交付本轮索引恢复与部署就绪校验；原任务已正式完成，无需再唤醒或发布。
- 未闭环项：原UAT2业务交付由原任务继续；历史wakes尚未全部ack，全局recover耗时阶段未收敛。

## 进展
- 2026-10-28：主检出较旧，已 fetch 并创建最新 main 独立 worktree。最新 coordination-summary.js 有固定“原事项”和版本变化文案，但递归来源尚未证实。

- 2026-10-28：完成现场反证、源码修复、302项集成及127项最终回归；发送未成功反例先失败后修复通过，进入PR交付。

## 重大决策
- 以普通进度询问只读回答作为核心回归，不把进度问题升级为协调操作。

## 重要信息
- 四事项：修复终审只读数据UPR导入覆盖并部署UAT2；修复新建未保存草稿UPR导入受限；修复草稿UPR导入物料名称回显并部署UAT2；按v4实现合并数据集UPR替换与来源保留并提测UAT2。
- 正式 profile：D:/dsh_home/profiles/web/cordis.patch.yml；存储配置指向 D:/dsh_home/storages/dingtalk-dsh-assistant-v9-pr116；Assistant 端口 18998；当前动态账本为 D:/baibu-agent/.dsh/task-sessions.sqlite。

- PR：https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/281；2026-10-28独立回读 number=281,state=OPEN。

- 2026-10-28：用户明确授权部署；PR #281 已 MERGED，merge SHA 4a6471d4cf4fc5b680a7d31c1427e1ec60113456。源码与当前 HEAD 无差异。正式任务会话实例无旧 workflow maintenance，按 task-session-clean-start 原生双包入口部署。


- 2026-10-28：SG5本地部署完成，新PID32564，Assistant2.2.1，包SHA256 2409c86b9b38f4fe619fef2c060bf3109d495f5ef89a140f51fa26fd917fd3f7；配置摘要保持，transportReady=true，degraded/3为部署前已有。旧汇总revision10、通知11、已送达10保持；当前安装代码投影验证四事项标题，历史aggregate缓存未刷新。证据docs/tmp/coordination-progress-deployment-20261028。非必要全库扫描精简仍待修复。

- SG6进展：精确退役入口210+1通过，部署检查67通过，PR285 OPEN，已打包。现场原v4 Owner继续派发本地验证，current-control拒绝busy；已请求用户选择正式暂停/恢复或自然排空。尚未调用退役接口，不可声称原卡片已收口。

- 去全扫版本已安装，新PID5600，57.5秒健康，入站/DWS正常，原协调已正式退役；v4模式RPC被Host writer拒绝，正在受信绑定路径内修复，未改原会话历史。

- 最终现场：PID44064在线，错误观察原工作卡已正式退役；原v4会话workspace-write事件seq7446及新轮次seq7449实际工具回包。需求/控制13不变。原wakes尚未ack，UAT2业务未完成；全局恢复历史登记慢的确切阶段未收敛。见report.md。

- 用户追加：不能只修本次，要杜绝同类。原生官方诊断证实原outputs有效WRITE_DAC=true/WRITE_OWNER=false；授权后仅该根补当前用户FullControl，verification verified，未改文件/所有者。Owner所谓入口不存在已被tool schema及无delegate尝试反证。

- SG11（进行中）：原发布c5/input8已真实接续，但Git common-dir写入与MSYS命名对象分别被受限环境拒绝。新增受信operator对精确原execution的权限纠正，复用原生mode，保留原检出/凭据/验证；不再把统一产物归档误作业务写根。方案docs/spec/publish-execution-native-permissions.md。

- 最新现场：round-9已证明原c5 input9、同session完整模式和真实Git读/暂存/提交/推送成功，独立PR392回读head=c56df87d。PID33984；技术阻塞修复完成，UAT业务仍在原任务进行。

- SG12（进行中）：用户反馈本地看板仍503。已实证动态库无observer_*索引，原始HTTP任务/待答复/详情503、群/话题200，实际Chrome看板可见原错误。索引only脚本29项相关验证通过，原c5发布已排空，等待最后只读核验与Owner自然排空后处理。方案docs/spec/local-observer-index-recovery.md。

- SG12完成：同包恢复PID13436，indexes-only迁移887ms，原正文/身份/schema不变；真实8API200及Chrome列表/原详情已恢复，原v4任务显示已结束。新部署验收增加observer-readiness，防止health正常但看板503误报成功。证据round-10.md。

| SG13 | 已归档任务物理迁移 | 已标记32任务及历史入归档表，正文/身份守恒、服务恢复 | 已完成 | round-11.md；浏览器详情未收敛，API详情通过 |
