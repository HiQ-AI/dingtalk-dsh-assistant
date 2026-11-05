# 第 11 轮：相关 Native 冻结回归

日期：2026-11-04。

## 结论与范围

第 10 轮五项超时已逐项证因并原时限/断言 5/5。继续原任务验证直接受影响的三个 Native 文件，结果 **57/57 PASS、0 fail/skip/cancel**；不是全项目测试，也没有真实模型调用。

| 验证范围 | 实际结果 | 总耗时 ms | 证据 |
| --- | --- | ---: | --- |
| 人工等待整文件（实际包含第10轮五项） | 20/20 PASS | 126347.8078 | `round-11/human-remaining.tap` |
| 话题路由整文件 | 34/34 PASS | 80698.4254 | `round-11/topic-routing.tap` |
| 模型选型整文件 | 3/3 PASS | 7700.6436 | `round-11/model-selection.tap` |

原命令尝试用负向 name-pattern 排除已经通过的五项，但实际 human TAP 包含完整 20 项；按真实覆盖登记，不声称只跑了余项，不把第 10 轮五项再次累加为 62。文件名 `human-remaining.tap` 保留原执行记录。

## 实跑与绑定

- 三文件独立 Node 进程串行，使用既有 web Native profile；没有改正式配置、凭据、生产数据或发送真实钉钉。
- human 使用含负向 name-pattern 的 `node --test --test-reporter=tap ... test/task-session-human-native.test.js`；另外两文件分别使用 `node --test --test-reporter=tap test/task-topic-routing-native.test.js` 和 `node --test --test-reporter=tap test/coordination-model-native.test.js`。
- HEAD `b2bc40706855a0f99567f2eeb608219951c266a4`，仍为本轮 dirty 工作树。`round-11/related-native-versions.json` 包含 229 项产品 JS、Native fixtures、human 测试和锁文件 before/after Git blob，前后一致；不是原始字节 SHA。另外两个测试文件在执行后登记当前 blob，不追称本轮有独立前置 hash。期间未修改这些测试/产品文件。
- runtime `d2a04eea7e0bdce8576a0a88014fcd348a092f94`、coordinator `ba9ff8d444261acb07f7db559f5b9c389013a454`、human `1701f51c2fe0f11d9ac765e115685874794621e4`、harness `5f804d55c45ec3847773838990e0b7f8ef4696b8`。
- `test/task-session-human-native.test.js`：`1701f51c2fe0f11d9ac765e115685874794621e4`。
- `test/task-topic-routing-native.test.js`：`a116681f89a4897148869812d95802c2016e1e40`。
- `test/coordination-model-native.test.js`：`53c59a3b630c4ed33bcc81cea09c20a7a0bc8226`。

三份 TAP 的 SHA256、计数和时长同列版本清单。human/话题路由/模型选型分别观测到 60/93/9 条生命周期阶段记录，全部 `aborted=false`；话题路由有 3 条纯单元用例，不虚构其生命周期记录。保留原时限和业务断言。

D 只读核对实际 TAP、SHA256、229 before/after 和四个关键当前 blob，确认上述覆盖及不重复计数；未运行测试或全量重审代码。第 10 轮失败与诊断报告保留。

## 可观察行为

- human 20 项包含原五项、两条积压事实答复、技术答复恢复/共享范围、授权变化 fencing、精确来源通知、HTTP 人工回答、只读执行结果核验、不空转、原 session 恢复、匿名缺原文件时保留修复进度，以及缺真实群回复绑定时 fail-closed。
- 话题路由 34 项包含 request-bound 空参读取、完整唯一 Task 首包、revised Topic 关联 Task 补读、各原 Task/session 的 reopen、回复收件人、旧回复恢复冲突、幂等、原始请求人归属、replan/claim fencing、并发与排空、Web 恢复、事项连续性和独立交付目标。
- 最终大合同首包在真实 AgentLoop 中观测 view=54073 bytes、最终 body=58435 bytes，未串行读取该唯一完整 Task；仍在 64KiB 内，不推广到所有五例、多 Task 或真实模型。
- 选型 3 项覆盖下一会话生效、活跃请求不漂移、route/decision/Owner 独立选择，以及退役设置不能恢复 planning。

## 未验证边界与下一步

相关 Native 回归已通过，不证明真实模型归属/动作质量或首回性能，不代表真实钉钉送达。未重复核心 250 项，源码未变范围复用第 9 轮版本绑定证据；既有固定摘要基线 FAIL 不被本轮掩盖。

原五例有界 Host/模型 A/B 仍未执行、真实调用 0。下一步仅收敛现有 provider 的必要显式字面配置与隔离凭据解析，不能为对照加载正式可写 runtime、改凭据或凭空补出生产完整 launch 配置；若使用既有 stanza 固定参数，两侧同参并披露生产最终 overlay 未核。新 PR/push/合并/部署、CI、真实钉钉和生产写均未执行。
