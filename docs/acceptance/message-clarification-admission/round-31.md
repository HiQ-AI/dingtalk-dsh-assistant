# 第31轮：原生回合中断的窄分类与原节点恢复

## 已核验根因及边界

生产活动原会话 `1cd4583d-71e3-4fb4-ad3d-24e56205d280` 的 seq563 为 engineering_repo_inspect search 调用，564 为唯一工具错误 `Error: [object Object]`，565 step/end，566 turn/end aborted/user，567 session/end-seed。旧 tools/result 在 AbortSignal 已取消时仍将错误记作 execution_tool_failed。该时间序列证明回合被用户中断，不足以证明工具错误必定由取消造成；本修复不把它冒充 provider 过载。

数据集原生过载未重分类另有来源屏障：activeRun 在重分类写入前执行 assertMessageTaskUnfenced。已核对原输入workflowDigest/nodeId/hash、唯一waiting、全部drained、零当前节点效果、暂停停止标记均通过；主代理原生只读registry证据也排除attached。零事项来源遗留fence修复由另一子目标处理，本轮不移除屏障。

## 实现

- 新执行：中断工具结果不再被泛化成工具失败；核对本轮原生 aborted/user 后标记 EXECUTION_TURN_INTERRUPTED。已接受结果仍优先。
- 历史：inspectLegacyTurnFailure 核验完整身份/最后本轮，并只接纳指定只读工具唯一泛型错误紧接用户中断；额外输入、提交、非用户中断、其他错误拒绝。
- node.failure.reclassify 的 previousCode/code 精确配对；仍检查当前来源、Task控制、run/node/session/lease/input CAS、排空、节点零效果。新审计artifact加到node.evidenceRefs，保留旧诊断；targetNodeId稳定使问题键跨租约不变。
- 中断类型不进入transientRecoveryReasons；Owner读取新失败观察和证据后走原resume-agent，一次续行上限保留。成功前置节点不重跑。
- 公开内部helper改名，artifact使用legacy-turn-failure-classification；已发布provider-reclassify命令ID保留以维持历史幂等身份。

## 本地实跑

- `node --test test/execution-session-native.test.js`：43 PASS（改名前完整回归）。
- 改名与严格命令字段后：`node --test --test-name-pattern='历史原生中断|旧未提交错误|provider暂态恢复|旧provider未提交|原生用户中断|历史中断证据|旧provider失败' test/execution-controller.test.js test/execution-store.test.js test/workflow-service.test.js test/execution-session-native.test.js`：14 PASS。
- 首轮定向因旧测试未传新增必填previousCode/code出现8 FAIL；已更新测试使用真实严格合同后14 PASS，未放宽生产schema。
- 现场JSONL只读谓词：eligible=true、lease1、inputSeq10、endSeq566、code EXECUTION_TURN_INTERRUPTED。无现场写入、部署或重启。
- 日志docs/tmp/sg14-native.log、docs/tmp/sg14-recovery-tests.log；registry只读证据由主代理保存为docs/tmp/sg14-native-registry-proof.json。

## 补充：封闭通用恢复旁路

独立review发现 `run.recover` 原本允许任意 recovery reason 转 ready，来源屏障解除回调也可经 controller.recover 触发，绕过中断专用 Owner 一次续行。现仅对 EXECUTION_TURN_INTERRUPTED 明确拒绝 NODE_RECOVERY_REQUIRES_OWNER，其余错误语义保持。

新增断言：直接 store run.recover、controller.recover、Owner已续行一次后的再次controller.recover全部拒绝，waiting与lease保持；正式Owner resumeNode仍成功且成功前缀不重跑。`node --test --test-name-pattern='历史原生中断' test/execution-controller.test.js`：1 PASS（包含上述3项反例），日志docs/tmp/sg14-interrupt-bypass.log。
