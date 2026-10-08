# 第59轮：统一本地部署入口

## 验证范围

统一入口复用既有部署、配置CAS与独立回读，不另建部署状态机。测试执行真实入口，将停机/安装/HTTP等外部helper替换为临时目录中的明确边界fixture；现有helper与配置恢复的原生测试独立运行。测试不得操作正式profile、控制库或计划任务。

| 场景 | 必须核验 |
| --- | --- |
| Check | 包/profile摘要实际计算；只调用零写检查，不创建部署证据或安装/恢复 |
| 单次部署 | 一次调用依序Check、安装且保持维护、Readback、Resume；输出只含汇总 |
| 活动Run配置漂移 | 在stop/install之前拒绝planned repository摘要失配，不修改旧Run/checkpoint |
| 失败 | Check/安装/回读任一步失败均不继续Resume，保留失败证据 |
| 已安装配置失败 | 只恢复本次配置并回读已有安装；不重复安装、不重放任务 |
| 重复Readback/Resume | 只调用指定既有生命周期入口，不进入安装阶段 |
| 输出 | 敏感边界输出不进入标准输出或异常摘要；详细证据保留在指定目录 |

## 当前证据状态

待脚本接口冻结后实跑。本轮测试通过只证明部署编排与对应helper合同；正式实例的维护、PID、包摘要、健康和Task续行由主线程另行独立回读，不能用fixture替代现场证据。

## 实跑结果

`node --test test/deploy-local.test.js`：10/10 PASS，78.30秒，日志 `docs/tmp/deploy-local-final.log`。首轮基础7例也全部通过，保留 `docs/tmp/deploy-local-first.log`。随后增加对预检结果 `writes != 0` 的精确拒绝，定向 `node --test --test-name-pattern=check-wrote test/deploy-local.test.js`：1/1 PASS，3.38秒，日志 `docs/tmp/deploy-local-check-zero.log`。

测试运行实际 `scripts/deploy-local.ps1`，仅在隔离副本中把固定正式profile位置改成临时profile，外部部署helper由fixture替换。真实入口负责参数处理、SHA计算、子进程、阶段顺序、日志与汇总；fixture不实现或模拟其算法。Check前后完整fixture文件集合和摘要相同；其余用外部调用记录验证不会在失败后恢复或重复安装。

完整覆盖：Check目录零写/实际SHA，单调用顺序及HoldMaintenance，重复Readback/Resume，检查/安装/回读失败立即停止，readback pending，恢复未确认，已安装失败携原launch与restore提案进入单次恢复，以及独立Readback/Resume未就绪拒绝。敏感标记保留在私有详细日志，标准输出和异常摘要中均不存在。

边界：受控restore用例只证明入口正确转发恢复身份及不额外发普通安装调用；配置字段恢复、原生plugin不重装及Task不重放需要既有helper测试和正式实例证据，不由fixture冒充。实现过程中补上独立Readback/Resume结果确认和Check必须零写结果的门禁。

原生部署完整性测试日志已独立回读：`docs/tmp/deployment-canonical-integrity-test.log` 共21/21 PASS（2097.5ms），包含活动工程配置摘要检查。该层直接核SQLite/计划配置，不用入口fixture代替活动Run漂移门禁。

## 正式实例执行与独立反证
统一入口使用 five-config-restore-deploy-arguments.json 完成配置恢复（0c94→3b5c）、原6deedf50包101文件回读、计划任务启动PID15188与Resume。详细日志 five-config-restored-deployment-runner，01:41:52汇总ready/dispatchResumed=true。01:47后的独立health返回degraded、收信false、回填STORE_UNAVAILABLE，maintenance API同错；因此不能将启动时成功冒充当前稳定健康。正在按既有Resident同Host重开路径排查恢复，新增Resume后轻量真实健康确认，不延长全量扫描。

## 追加：恢复后的轻量运行回读

实际01:41部署结束后01:47发生STORE_UNAVAILABLE，前一时点成功不能证明后续持续可用。最小改进将 core 的 `Read-DeploymentRuntime` 同时用于普通回读与 resume 操作后：GET /health 必须status=ok，GET /runtime/maintenance 实际读取store且维护ID一致；恢复后还必须active=false。结果记录checkedAt。canonical同时核ready/dispatchResumed，任何失败均非零退出，不补发恢复或重装。

不在Resume后重复整个Read-Deployment的任务/工件/包遍历，不增加观察时长、轮询或Assistant状态。`test/deploy-owner-repair.test.ps1` 全文件实跑通过，新增恢复后health degraded与store不可用2/2 PASS，日志 `docs/tmp/deploy-runtime-readback-helper.log`。原restore一次不重装3/3及同秒失败身份4/4继续通过。

编码与本次恢复确认变更后的入口定向回归：`node --test --test-name-pattern='Check实际|fail-check|fail-readback|resume-not-ready|独立Resume' test/deploy-local.test.js`，5/5 PASS（33.33秒），日志 `docs/tmp/deploy-runtime-readback-canonical.log`。包含恢复返回dispatchResumed=true但ready=false时拒绝成功。配置restore 11/11由负责代理实跑并回报（原工具输出chunk3c021f、1140.5ms；未另存日志），此处不冒称独立日志回读；其精确现场恢复另由主线程记录。
