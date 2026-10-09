# Round 82：固定执行会话纠正与冻结候选批量搜索

用户最新范围：暂停其他未完成任务，仅推进 SG20；取消依靠动态流程修订修故障。此轮未操作现场 Task 控制、未推进其它 Task。

## 固定职责恢复

SG20 原 plan-local-acceptance 输出 cases=[]，prepare-local-acceptance 拒绝；原场景输入正确。Controller/worker 复用 node.resume，让原规划 session 收到完整失败证据。原 Task/Run/generation、会话和成功节点保持，仅 planner 重新提交及失败准备输入重建。维护/暂停、来源/版本、零失败节点效果和全Run无未知效果继续验证；不重发外部操作。

- `node --test test/execution-controller.test.js`：112/112 PASS，docs/tmp/fixed-flow-controller-full.log。
- 原生HTTP+Service控制及固定纠正定向：9/9 PASS，docs/tmp/fixed-flow-final.log。
- 真实v18工厂案例：原planner session和node ID不变、lease+1，另7个成功节点逐字段相等且执行次数1；paused、unknown效果、失败准备已有effect反例拒绝。外部验收节点在测试边界停止，不冒称业务E2E完成。
- pause/resume API接受requestId/reason/expectedControlRevision，走原controller.controlTask；不以cancel代替pause。

## 搜索性能

原tool搜索针对2657文件逐文件git cat-file，limit10仅最后slice。新路径约4MiB按冻结OID批量读，每条验证OID/type/size/hash、分隔及总长度，保Unicode/跨行/二进制UTF8 substring语义。signal透传snapshot、远端校验及workspace查询链；不操作已有会话。

- `node --test test/execution-candidate.test.js`：17/17 PASS，docs/tmp/round82-batch-tests.log；含多批、Unicode/跨行/二进制、取消、缺失blob。
- 真实当前仓库index投影2657文件，16,888,597字节，打开1118ms、批量搜索854ms、3匹配。只使用既有index生成冻结Git tree，未编辑index/业务源码，未派发现场工作流。docs/tmp/round82-real-search-proof.json。
- 五个实际active注册定义以installed命令路径重建，5/5 exact digest相同（18×4、19×1），docs/tmp/fixed-flow-active-digests.log及local-revision-active-restore-proof.json。

## 边界

没有停止未知PID或填工具假回执。原SG22搜索在维护中后来自行结束，此轮性能验证不等于原Task已完成。正式部署后应先在维护中暂停其它任务，再恢复 SG20，独立验证原planner会话实际纠正和本地验收。

`node --test --test-name-pattern='工程空方案重发|远端引用单次读取' test/workflow-engineering.test.js`：2/2 PASS，docs/tmp/round82-registry-search.log。真实registry搜索分页（offset超总量返回空、total稳定）、读取范围及远端信号回归通过。

## HoldMaintenance 暂停实际场景补验

`node --test --test-name-pattern='HoldMaintenance封存|Web暂停恢复' test/workflow-service.test.js`：2/2 PASS（docs/tmp/hold-maintenance-pause.log）。在runtime active、phase=stopping、drained=true下，等待Task正式pause首次返回pausing；原Run写user_pause后，同requestId/原控制版本/同body重投，复用原control收据并原生settle为paused。维护不退出、不加版本，claimCount/generation/全部节点结果不变；新request配旧控制版本仍拒绝。

实跑发现control.changed事件曾用settle后的最新plan revision，重投会COMMAND_ID_CONFLICT；现使用原control收据中的revision固定事件身份。一行修复后上述2例通过。没有放松维护门禁或直接写控制账。
