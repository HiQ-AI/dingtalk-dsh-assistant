# 第 10 轮：五项 Native 超时定位与定向复验

日期：2026-11-04。

## 范围与结论

用户明确要求“继续跑验证，先查清那5项超时”。Lead 在当前工作树逐项独立进程、串行恢复旧测试；5/5 均复现原 business 30000ms 超时。完整私有工具快照逐项核验表明：脚本模型不消费 Host 的 `topic_route_context_unread` 补读 `nextCall`，反复提交路由。采用既有 `1701f51c` 四行适配后，原五项 **5/5 PASS，0 fail/skip/cancel**，prepare/business/cleanup 全部 `aborted=false`。这解决本次五项测试阻塞，不证明真实模型首回提速、下午业务问题全部解决或整个功能已交付。

- 工作树：`worktree-first-reply-latency`，HEAD `b2bc40706855a0f99567f2eeb608219951c266a4`；仍有本轮未提交源码/测试改动，不仅用 HEAD 绑定。
- 本阶段产品源码未改：runtime `d2a04eea7e0bdce8576a0a88014fcd348a092f94`、coordinator `ba9ff8d444261acb07f7db559f5b9c389013a454`、共享 Native harness `5f804d55c45ec3847773838990e0b7f8ef4696b8`。
- 旧测试 base `f7215aa9884db8872c9642bf867d79ad0e43a59b`；仅诊断版 none 为 `c163887f`，其余为无损 gzip 诊断版 `aaa5502e`。失败后、关闭资源前通过只读 query 保存实际请求、工具、账和状态；不改 business 时限和断言。
- 最终去诊断测试 `1701f51c2fe0f11d9ac765e115685874794621e4`。`round-10/native-five-versions.json` 记录 229 项源码、测试和锁文件 before==after，无漂移；五份最终 TAP 的 SHA256 同列其中。
- 使用已存在的 web Native profile；工作树默认 resident profile 缺少 dsh-base，未安装、改正式配置或凭据。恢复前可用内存 14.61/31.73GiB 为单次资源快照，不作根因证据。

## 逐项失败证据

`round-10/timeout-diagnosis.json` 保存脱敏统计、实际错误/nextCall、合成消息停点、阶段耗时及失败 TAP 摘要。下列工具计数来自清理前快照；不把 none 异步写盘结束后的 809 次计数与快照的 632 次混称同一采集时点。

| 用例 | 旧 business ms | 快照请求/工具结果 | 未读路由拒绝次数 | 实际阻塞位置 |
| --- | ---: | ---: | ---: | --- |
| none | 30016 | 632/632 | 631 | `unrelated-owner` 路由 pending |
| empty | 30013 | 699/699 | 698 | `unrelated-owner` 路由 pending |
| tool-limit | 30039 | 720/720 | 719 | `unrelated-owner` 路由 pending |
| topic | 30056 | 673/679 | 661 | `business-answer` 路由 pending |
| fact-followup | 30067 | 726/740 | 715 | `fact-question` 路由 pending |

五项均为 `status=context-required`、`error=topic_route_context_unread`，要求 `group_topic_context_get` 的 `section=unsummarized`、`offset=0`；topic 变体 revision=2，其余 revision=1。实际 `group_topic_context_get` 调用均为 0。

- none、empty、tool-limit：仅完成原 `task_request_human`，无 Decision 请求，停在 unrelated-owner。旧失败没有覆盖后面的空返回恢复或伪造来源工具上限分支。
- topic：前面已有 5 个 Decision 模型请求、3 次 decision_submit 及 3 次隔离发送/回读；原交办与无关消息均已结清，后续 business-answer 才被路由门禁阻塞。不能称全程未决策或未发信。
- fact-followup：原只读核实已有 1 次 delegate、1 次 execution_submit，execution 已 succeeded/drained；新 fact-question 卡在路由。不能称全程 0 执行，也未进入追问事实复核。

对应失败输出为 `round-10/{none,empty,tool-limit,topic,fact-followup}-interrupted-repro.tap`。五项都正常到达原业务超时，cleanup 完成；不是宿主强制 kill。

## 因果与修复边界

`packages/dingtalk-dsh-assistant/topic-runtime.js:1238` 的 `checkUnsummarized` 对被引用 Topic 要求读取真实未汇总增量，缺读时返回明确补读调用。普通决策不再强制重写摘要后，测试脚本也须履行这项读取合同。

比较并排除的解释：

1. **脚本漏读**：五项实际反馈均为未读、重复提交；补读调用为 0。去除临时诊断后，精确 f721 到 1701 的完整差异只有公共 fixture 四行消费真实 nextCall，五项即通过，支持此直接原因。
2. **Decision/Task 版本或审阅门禁**：前三项及事实追问尚未到本次 Decision；topic 后段同样只见路由未读拒绝。后续原版本/审阅断言在复验中通过，不将这些门禁删掉换取通过。
3. **单纯内存保护**：五个独立进程都正常报告原 30 秒 business 超时并完成 cleanup；与原批次随后遭宿主保护中断分开。该结果不推断整个系统内存原因。

`test/task-session-human-native.test.js:40` 的适配只在路由角色最近工具值明确为上述 context-required 时执行 Host 返回的工具名和参数，不伪造工具结果、不自动登记已读，不修改来源/权限/版本、业务断言、生命周期实现或产品门禁。最终文件精确恢复 1701，诊断钩子/import 全部移除；原 f721 内容也在去诊断后核 hash 一致。旧 anonymous 单例的 summaryContext 补读是此前独立修正，不能用它代替本次路由因果。

## 原断言定向复验

每例使用原完整测试名，`[regex]::Escape` 后加 `^...$`，独立 Node 进程串行执行：

```powershell
$env:DSH_NATIVE_TEST_PROFILE = 'D:/dsh_home/profiles/web/package.json'
node --test --test-reporter=tap "--test-name-pattern=^<escaped exact case>$" test/task-session-human-native.test.js
```

没有全量测试或真实模型调用。未降低注册时限，原 business=30000ms；下表时间仅为脚本模型 Native 测试业务阶段，不是线上首回耗时。

| 用例 | business ms | cleanup ms | 结果 |
| --- | ---: | ---: | --- |
| none | 1584 | 106 | 1/1 PASS、0 skip/cancel |
| empty | 8198 | 163 | 1/1 PASS、0 skip/cancel |
| tool-limit | 1664 | 59 | 1/1 PASS、0 skip/cancel |
| topic | 2644 | 122 | 1/1 PASS、0 skip/cancel |
| fact-followup | 4900 | 240 | 1/1 PASS、0 skip/cancel |

最终输出为 `round-10/{none,empty,tool-limit,topic,fact-followup}-final.tap`。

原业务断言继续验证：无关来源不解除等待且不空转；完整 UAT2/点击编辑即持久化限制不丢；复核禁止 delegate/write/提前完成；空返回沿原 session 恢复；伪造来源保持 `DYNAMIC_HUMAN_REVIEW_SOURCE_INVALID` 且不冒充 provider recovery；Task 的 session、requirement/control revision 不变。事实追问按真实 execution result/model_content_read 复核，内部标识不外发，单次通知已隔离回读并 delivered；原待批准问题保留，不新增执行/写操作、不生成 human.responded，无关后续不重发。

D 已独立只读复核五份失败快照；最终又以 Git 换行规范化规则证明去掉四行即精确得到 f721，核对原断言和五份 PASS/SHA256，并独立批量检查当前 229/229 文件与 before/after 一致。未运行测试或写文件，不把只读审查冒充另一次测试执行。

## 证据与清理

- 失败与复验 TAP、脱敏逐项诊断、源码 before/after 及 SHA256 保留在 `round-10/`；第 9 轮报告、失败状态不覆盖。
- none 原始 252021095 字节快照已无损压缩，解压 SHA256 与原文一致：`59c67cc81c0e407c1fc9ef0a074ca4422dce683cc6eaa97eaab7a19c339a7bf0`。原 raw 与恢复1701的临时副本已结束用途并清理；未动未知 stackdump 或他人文件。
- 完整快照仅用于本轮私有诊断，始终位于既有 ignored 桶，未入库/公开。最终报告、脱敏摘要与版本独立回读后，已清理五份完整诊断快照；原 TAP 私有路径不再有效，保留逐项统计、实际 nextCall/终态摘要、D 独立核验结论和复现配方，不保留重复工具 schema。

## 剩余范围

这五项的直接原因与修复复验已收敛；原首次回复优化总目标仍活动。最新版本的相关 Native 余项、topic 路由和两级选型、隔离真实模型 A/B 尚未完成。250/250 核心单元证据在未改源码范围继续有效，不重复跑。真实调用仍为 0，无新 PR/push/部署/CI/真实钉钉或生产状态写入；下午附件/JSON与部分调度因果、既有固定摘要基线 FAIL 继续披露。
