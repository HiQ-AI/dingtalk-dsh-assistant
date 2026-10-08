# 第60轮：SG20真实本地准备定义的checkpoint恢复

真实v18 factory的prepare-local-acceptance/version1/code仅声明workspace.prepare。validatePlan先于local.prepare执行，LOCAL_ACCEPTANCE_PLAN_INVALID且无输出/效果时具备原有checkpoint恢复条件；旧Controller仅pure/read导致实任务无法恢复。

本轮只改execution-controller.js updateEngineeringCheckpoint：该节点/版本/code只额外接受精确单项workspace.prepare，不允许混入external.operation。worker无需修改，其全drained、前缀成功、零实际effects、无output、维护/Task/来源/版本CAS仍直接执行。

新增使用createEngineeringTaskContextWorkflow真实v18的三个Controller+SQLite回归；保留factory define/plan/prepare-local实际实现及所有节点身份/version/executor/effects，只隔离非本次业务前缀执行边界。第一次计划cases空触发真实LOCAL_ACCEPTANCE_PLAN_INVALID，local.prepare调用0次；原8前缀已成功，checkpoint后仅define/plan重评，其他6节点的完整记录（身份/输出/lease）逐项相同，原Run/gen不变，新合法计划实际prepare一次。其他effect声明及实际succeeded效果记录拒绝且节点状态不变。

实跑 `node --test --test-name-pattern='本地验收checkpoint|v18真实factory本地' test/execution-controller.test.js`：14/14 PASS，11724.3ms，日志docs/tmp/sg20-real-factory-checkpoint-final.log。覆盖原scope/maintenance/revision/已执行本地/错误码/效果反例与新增3例。单独新增3例1899.7ms通过，日志fourth。first/second/third日志保留夹具接线失败（缺delivery、误用session binding字段），修正夹具后实跑，不将这些当业务失败；首轮遗留测试进程按明确测试命令身份停止，未触碰正式进程。

尚未部署或现场checkpoint，不能声明SG20已完成。后续由统一脚本安装新包，再对原Task/Run/gen执行正式checkpoint并核实际业务验收；不改业务repo或直接改控制库。

现场：4afb包真实部署后单SG20checkpoint成功1、Host诊断events2，原gen4 define/plan lease2重评成功；SG18精确controller.recover收据1、原apply lease3 running，尚不宣称新增edit已完成。桥末尾whenIdle被maintenance阻止抛RUNTIME_MAINTENANCE_ACTIVE，原report failed/closed=true保留；独立exclusive回读证实已持久成功部分、原前缀和queued未领取/零新effects，未重投。恢复Resident原profile后maintenance517 inactive，health/收信正常。证据 sg20-v2-exclusive-readback 与对应manifest/report，实际业务完成另行核。
