# Round 19 — 检查阶段预算与失败日志持久化

## 实施

- `execution-check-job.js`：总 timeoutMs 默认仍120000，上限1200000；steps可显式timeoutMs，最大600000。执行deadline为步骤预算与总剩余时间的较小值。逐步记录startedAt、elapsedMs、有效budgetMs、timeoutScope（step/check/null），保留取消和进程树排空门禁。
- `task-workflow.js`：确定验证失败附带有界、无损的已采集日志分块证据；每块16KiB原始UTF-8字节，以base64保存，并带日志SHA、分块序号、检查标识和候选身份。最多32checks×4块=128块。
- `execution-controller.js`：仅受信code节点的ENGINEERING_VERIFICATION_FAILED可走本路径；将证据写入原64KiB上限的内容地址工件，再在waiting节点evidenceRefs引用。保持失败等待语义，不启动下游。
- README及本地执行runbook已说明明确配置install600000/build600000/总1200000的契约，以及必须真实完整PASS才准入。

## 实跑

```powershell
node --test test/execution-pr.test.js
node --test --test-name-pattern='失败工程检查' test/task-workflow.test.js
```

- 第一条4/4 PASS，包含真实子进程的首步预算耗尽、第二步独立预算耗尽、总预算跨步骤不可重置三个反例；超范围step与total拒绝；已有取消/超时清理父子进程及后续不运行仍通过。
- 第二条1/1 PASS（4989ms）：真实Git冻结候选的检查失败，保存约40KB多行日志分为多个工件；独立读回所有evidenceRefs，按part重组后与原日志逐字节相同，SHA256匹配；节点仍waiting、outputRef=null、下游0次、effects为空。

没有改动消息/Agent预算。没有通过自动延长、忽略失败或把失败节点伪装成功来通过验收。真实dataset-web安装/build的最终结果由父任务独立记录，此处不声称该真实工程已PASS。

## 日志大小反例补验

原结构在顶层及steps重复末步stdout/stderr；20KB控制字经JSON转义后可超64KiB，导致结果验证拒绝并丢失检查原因。本次去掉顶层重复输出：顶层只留退出与超时摘要，逐步证据仍完整。普通有效UTF8输出保持文本；控制字/无效UTF8使用每流明确标识的base64无损保存，按原始字节计20KB总额。命令与root配置共同限制8KB，给结果结构保留空间。

定向实跑：

```powershell
node --test --test-name-pattern='20KB' test/execution-pr.test.js
node --test --test-name-pattern='失败工程检查' test/task-workflow.test.js
```

均1/1 PASS。真实Node子进程输出10000个NUL到stdout和10000个0x01到stderr并以3退出：日志小于64KiB，各流解码逐字节一致；另一真实子进程输出20KB引号/反斜线，文本转义后也小于64KiB。正式工程失败节点测试改为使用该真实控制字符子进程，仍保存waiting/ENGINEERING_VERIFICATION_FAILED，通过evidenceRefs重组原始日志与两路输出，无CANDIDATE_CHECK_RESULT_INVALID，下游0次。

此前完整execution-pr执行中原4项PASS，新反例第一次因测试把20KB文本直接写进argv触发既有配置上限失败；已仅把测试argv改为短固定代码生成相同输出，定向重跑通过，没有放宽配置限制。没有运行全仓。

## 真实构建样本驱动的最终界限

随后真实仓库独立 Node22 build 已由业务验证方报告 PASS，执行583527ms；stdout22823字节+stderr2533字节，另有安装输出1178字节。原20KB输出门禁会拒绝这种正常结果，且600秒构建预算仅余约16秒。保留先前失败事实，作以下明确、有限调整：

- 原始输出总额改为 **32KiB（32768字节）**，所有步骤共用；超限仍停止且FAIL。
- 每流选择有效UTF8文本时还比较实际JSON编码长度；长于base64则无损base64，避免32KiB引号/反斜线经转义超过结果64KiB。配置仍受8KB上限，未新增磁盘日志架构。
- 显式单步上限改为 **900000ms**；Host例为安装600000、构建900000、总1200000。总deadline仍优先约束，默认120000不变；并非两步预算可简单相加。

最终定向命令 `node --test test/execution-pr.test.js` **6/6 PASS**（10830ms）。新增真实子进程测试复现26534字节安装/构建总输出并PASS；32768字节引号/反斜线边界PASS且解码逐字节一致，结果小于64KiB；32769字节输出明确output_limit、FAIL，下一step没有执行。既有步骤/总预算、取消进程树、控制字符反例仍通过。

本次参数边界依据已观察样本确定，不再自动增长；实际fresh完整安装/build仍由业务验证方执行，增加界限不代替完整PASS。源码已冻结供同版实跑归因。
