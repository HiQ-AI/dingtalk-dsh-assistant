# 发布准备证据与流程修订

插件的任务流程库默认空，生产发布与数据变更正文属于用户配置。本次以离线修订脚本为已有配置生成候选，不添加插件内置业务流程，不直接修改运行配置。

## 生成可审阅候选

先读取当前 `/state/agent-config` 到本地受控备份路径，并检查在途任务是否仍引用旧流程。配置可能包含敏感信息，只保存在本地 `docs/tmp/<本次目录>/`，不得提交。以下命令在仓库根以 PowerShell 运行：

```powershell
node docs/acceptance/resident-leaf-coordination-repair/scripts/release-preflight.mjs --check --input docs/tmp/<本次目录>/before.json
node docs/acceptance/resident-leaf-coordination-repair/scripts/release-preflight.mjs --write --input docs/tmp/<本次目录>/before.json --output docs/tmp/<本次目录>/proposed.json
```

`--check` 只读输入并输出目标 ID/版本，不写文件、不发网络请求。`--write` 只创建新输出文件，存在则失败，不覆盖原文件。只追加两个流程的前置步骤，保留其他流程和所有无关配置；两个目标流程各增一个 revision，配置总版本增一。修订标记已存在则不重复追加/增版。缺少任一目标流程时停止，不猜测替代 ID。

正式配置更新由部署步骤执行：先解决在途任务引用旧流程的影响，使用读取时的 `taskPromptsVersion` 作 CAS 输入，只提交 `taskPrompts` 与旧配置版本；Store 负责生成新 revision。回读实际总版本、两个正文及 revision，并逐字段比较无关配置；版本冲突时重新读取和审阅，不覆盖并发修改。离线候选的 proposedVersion 不能当作 CAS 输入版本。

## 生产前置证据契约

脚本导出的 `assessReleasePreflight` 接受以下结构；CLI 加 `--evidence <文件>` 可执行相同检查。证据引用必须指向本次可核验材料，敏感原文不进入 Git。

| 字段 | 必要内容 |
| --- | --- |
| baseline | environment=`production`、readOnly=true、observedAt、evidenceRef |
| candidate | revision、dependencyInventoryComplete=true、requiredObjects 数组、evidenceRef |
| observations | 每个 requiredObject 唯一记录 name、status=`present/missing/unknown`、evidenceRef |
| rehearsalEnvironment | authorized=true、isolated=true、available=true、runbookRef、evidenceRef |
| executionOrder | steps 有序唯一数组、dependencies 的 before/after、stopConditions、rollbackScope、evidenceRef |

实际证据显示基础对象 missing、未授权或非隔离演练环境、阶段顺序违背依赖，均为 FAIL；缺基线、未声明依赖清单完整、缺对象证据为 UNKNOWN。任何 FAIL/UNKNOWN 都不能进入生产执行，CLI 返回退出码 2。PASS 只表示提供的证据契约完整且未发现已声明矛盾，不能证明引用正文真实、SQL 已通过、已获生产授权或业务 E2E 通过。

现有 runbook 允许且隔离的 UAT 可以作为演练环境，无需先启动 Docker；共享 UAT 不代表任意 SQL 演练授权。后台构建/测试优先复用已有 job 完成事件唤醒；流程文字本身不会增加原生事件能力，没有事件能力时必须如实记录限制，不能声称已消除所有轮询。

## 验证

```powershell
node --test test/release-preflight.test.js test/task-reports.test.js
```

测试覆盖缺基础对象、未知前提、错误顺序、共享 UAT 拒绝、配置保留/幂等修订，以及报告等待和恢复协议。真实生产前置读取、用户配置更新、实际后台事件与运行效果需要部署阶段分别留证。
