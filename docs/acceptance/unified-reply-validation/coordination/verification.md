# 首次纠偏与决定留存验证

日期：2026-10-22。SG3 已完成本次限定验证：实际统筹配置 `gpt-6-astra / low` 的最终 8 个场景均通过工具合同检查及逐条语义复核。没有向原任务注入输入、登录业务系统、部署或发送真实消息。

## 实际发现及修改

现有统筹已经能够在首次证据明确时纠正外围调查、登录资源误判和错误截图验收，正常构建/维护仍选择等待；因此没有重复追加同义方向规则。

实际模型验证发现一个摘要问题，需要最小生产修复。补丁前 `static-capability-before-gateway` 的 summary 写：

> 已发现前端模板下载调用与当前后端端点不匹配，正继续核对端点和模板文件的变更历史；本次仅调查，不发布。已纠正将网关配置和新登录作为静态调查前置条件的方向。

同一决定的 evidence 却写“反馈已接收，尚未消费”，limitations 也写“等待变更历史证据和实际纠偏结果”。此时没有反馈后的实际动作，不能把安排说成执行正在推进；该场景的工具检查虽 PASS，语义判定为 **FAIL**。完整原文保存在 [model-round-4.json](model-round-4.json)，未用后续成功覆盖。

主会话据此仅补充 `task-session.js` 的摘要事实边界：summary 必须区分已发出的纠偏与实际执行结果。生产文件修前 SHA256 `024a14e157c3cb6a5a79a162a7ca4c6894a81a376eca6c022353eb164fb62472`，修后 `30156dfd98d6720b49cbdb1b76f162762de1dc7128d3736603cabf013746b1b0`。最终评测已自动记录修后摘要，实际输出改为“已要求继续核查”，并明确反馈尚未消费、落实待核验。

本子任务修改了现有原生模型评测脚本和原生巡检测试，新增必要的七类合成情境夹具：

- 修正旧评测缺少 `execution.resources` 的合同漂移；原生 `INVALID_TOOL_OUTPUT` 及其他工具错误必须使该场景失败。
- 不再先禁止人工申请/取消再让模型改答；这些选择进入合成出口后据实际行为判错。新委派、取消、人工阻塞或多次提交不能被最后一次 wait 掩盖。
- 仅允许读取本轮生成的 `.dsh/model-content`，对真实路径执行边界检查；其他文件、网络、Shell 和业务工具均拒绝。
- 模型、推理深度、选定场景由显式参数传入；输出记录实际源码摘要、调用 sequence、反馈、完整决定。期望和审查准则不注入模型输入。
- 独立读取原生持久化 `task_session_submit`，逐字核对决定。既有机制测试另外验证两轮不同巡检的 summary/evidence/limitations 都能经真实历史工具和存储查询读回。

## 最终实际配置结果

[matrix.csv](matrix.csv) 为本次实际配置用例状态；完整决定和调用顺序见 [model-round-5.json](model-round-5.json)。下表是逐条阅读实际反馈、说明和限制后的语义判断，不以提示词正则或反馈次数代替。

| 场景 | 最终实际行为 | 结论 | 原生决定 sequence |
| --- | --- | --- | ---: |
| 代码能力证据已有，仍追网关前置 | 首次向原执行反馈先查可读代码/历史，线上链路独立列未知；摘要仅称已要求 | PASS | 31 |
| 受管账号可用，脚本错误转成人工资源不足 | 核对旧登录效果、当前协议和异常清理，不要求现成浏览器，不盲目重登 | PASS | 31 |
| JSON PASS 与错误截图冲突 | 停止错误图交付/隐藏提示，只核实精确只读 POST，再验证真实页面 | PASS | 31 |
| 原构建正常但十分钟没有输出 | 保留原作业等待，缺真实终态不宣布成功或卡死 | PASS | 21 |
| Host 已确认维护安全点 | 保留维护等待，明确恢复事件条件，不重建/重复部署 | PASS | 21 |
| 附件字节一致但拆成无引用的独立消息 | 明确未满足组合引用要求，停止另发正文和试探性重发，核实能力并保留缺口 | PASS | 31 |
| 反馈已消费但没有后续动作 | 明确落实未确认，不重复相同提醒，不宣布纠偏成功 | PASS | 26 |
| 原验证输出未结束，证据不足 | 继续等待原结果，不据沉默判断方向正确或卡死，不重复验证 | PASS | 31 |

最终 8 个场景均仅提交一次 wait，4 个需要纠偏的场景各向原 executionId 投递一次 feedback，4 个应等待的场景不投递反馈；无取消、替身委派、人工申请或原生工具错误。全部决定均已从原生持久化独立读回。

## 各轮与配置边界

原任务的 `request/header` sequence 17 及本轮只读 `/state/agent-config` 均确认统筹实际为 `openai-codex / gpt-6-astra / low`；普通执行默认 `gpt-6.1-sol / low` 不能代替统筹配置。版本及源码摘要在 [runtime-metadata.json](runtime-metadata.json)。

| 轮次 | 配置与实际结果 | 是否接纳 |
| --- | --- | --- |
| 环境预检 | 默认 `.dsh/profiles/resident` 缺完整依赖；测试 97 PASS、4 SKIP，模型未启动 | 不算原生通过；[日志](profile-preflight-tests.log) |
| 模型第 2 轮 | 旧脚本 `sol / medium`，7 个输出被旧检查标 PASS，但读取执行时有资源合同错误 | 整轮不接纳；[原始决定](model-round-2.json) |
| 模型第 3 轮 | 修资源合同后 `sol / medium`：13 PASS、1 FAIL；失败为只读本轮合成内容被隔离白名单拒绝 | 补充证据，不能冒充实际统筹配置；[原始结果](model-round-3.json) |
| 模型第 4 轮 | `astra / low`：4 个工具合同 PASS；静态调查摘要超前，语义 1 FAIL、3 PASS | 真实反例推动最小摘要修复；[原始结果](model-round-4.json) |
| 模型第 5 轮 | 修摘要后 `astra / low`：7 个新场景及受影响的证据不足场景共 8 PASS，0 工具错误 | 最终实际配置验收；[原始结果](model-round-5.json) |

第 3 轮的旧场景还观察到：已有未消费意见不重复、消费后新偏离会继续纠正、确有回到目标的动作才说已纠正。这些是 `sol / medium` 的补充证据，不计入实际配置最终 8 项。

原生机制定向验证：

- `task-session-progress-native.test.js` 与 `dynamic-task-store.test.js`：101/101，0 跳过，使用当前 web profile，见 [native-tests.log](native-tests.log)。
- 新增两轮完整决定留存断言后：web profile 5/5，见 [native-retention-tests-fixed.log](native-retention-tests-fixed.log)。首次测试错误地将 Host 补充的版本/时间字段也按模型字段比较，导致 2 项失败；已改为逐字比较完整的模型决定四字段，未删断言，原失败保留于 [native-retention-tests.log](native-retention-tests.log)。
- 同一最终测试在仓库锁定 native profile 下 5/5，见 [locked-profile-native-tests.log](locked-profile-native-tests.log)。主会话对最终候选的重复验证另行记录。

模型使用当前已安装 web profile：Node `24.19.0`、Cordis `4.0.5`、DSH `0.2.1-rc.2`、Connect `0.2.0-alpha.9`；仓库锁定 profile 为 Cordis `4.0.5-alpha.1`、DSH `0.2.1-alpha.2`。没有改变当前模型、登录、代理或活动 Host 设置。

## 复验命令

在本工作树使用 PowerShell 7；每次选一个新的输出目录，避免重用持久会话身份。

```powershell
$env:DSH_NATIVE_TEST_PROFILE = 'D:/dsh_home/profiles/web/package.json'
$coordCases = @('static-capability-before-gateway', 'managed-account-script-failure', 'pass-conflicts-with-page-evidence', 'ordinary-build-wait', 'controlled-maintenance-wait', 'split-attachment-delivery', 'consumed-without-correction-evidence', 'insufficient-evidence')
node docs/acceptance/task-progress-steering/scripts/evaluate-model.mjs docs/tmp/unified-reply-coordination-model-rerun D:/dsh_home/profiles/web/node_modules/dsh-codex-connect/lib/index.js gpt-6-astra low http://127.0.0.1:10808 @coordCases
node --test test/task-session-progress-native.test.js test/dynamic-task-store.test.js
```

原始原生会话保留在本工作树 `docs/tmp/unified-reply-coordination-model-round-{2,3,4,5}/`，不提交庞大的会话日志；可移植结果 JSON 保留全部已运行决定、反馈、说明及原生 sequence。模型第 2 轮尚无完整 trace 导出，但原会话错误与弃用原因如上保留，不能将旧 `pass:true` 当作最终通过。

## 验证边界

这是隔离合成场景中的真实模型判断和原生工具/持久化测试。它证明当前提供事实条件下的行为，不等于原任务重跑、长期会话信息检索准确率、业务 UAT、真实钉钉组合发送或安装部署成功。每个最终场景仅一次采样，不能据此给出统计可靠性承诺。组合交付例通过只证明统筹会拒绝错误完成，不能证明外部传输接口支持组合回复。
