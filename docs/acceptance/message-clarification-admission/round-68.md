# Round 68 — Owner 调整工程任务副本

## 结果与边界

本轮 registry/合同/Service 接线与定向工程执行通过；没有部署、运行线上业务或将五个原任务标记完成。真实云 Owner 回放见 round-69，不能用本轮合成模型 fixture 替代。

- `task-revision-contracts-all.log`：24/24 PASS。Owner 对未知失败读取真实证据后选择 Host 检查修订；外来诊断与 unknown effect 拒绝。
- `task-revision-final-flow.log`：3/3 PASS（79.97s）。真实 registry/Controller/Store、Git 工作区、进程检查、loopback 服务业务值与清理、真实本地 commit/push、PR API fixture 独立回读。删除零效果 apply 后保留原 Task/Run/generation 与成功 prefix 的 outputRef/lease，继续到交付证明；没有 edit 效果。prepare-local 的计划依赖绑定本 Run 成功节点真实工件。
- `task-revision-proof-final.log`：3/3 PASS。revision 与既有 checks checkpoint 的交付证明绑定登记来源及原生回执；伪 run/fromDigest/toDigest/task/kind 和缺原定义拒绝；注册后重启恢复摘要不变。
- `task-revision-last-targeted.log`：3/3 PASS。包括移除按 NO_CHANGE 错误码抢先自动恢复的回归。
- `active-registry-restore-proof.json`：当前四个 active v18 Run exact digest 全部相等。控制库只读、无 dispatch/command；当前源代码仅为离线部署位置模拟固定 execution-task-command.js 安装绝对路径，没有改工厂函数或摘要比较。
- `sg18-native-read-proof.json`：真实 SG18 原生会话成功 read 工具回执与当前文件完整 SHA 吻合，恢复 1 条路径；伪 inputDigest 拒绝，无业务写入。此项只证明读事实，不是业务验收。

## 修改范围

workflow-engineering 复用可信模板生成 Task 独立副本，提供完整 Host checks/profileDigest、节点合同及原依赖，保留原目标与必要实际验收/交付职责。只接受数据合同和实际工件引用，不接受模型函数或任意执行命令。旧 definition 不加新回调；validateRevision 只属于新副本。

task-workflow-contracts 将能力与真实等待证据交给原 Owner；Service 接入 registry 和只读原生会话记录，移除旧 NO_CHANGE 扫描特判。resumeCurrent 限纯/读取且零 node effects；settleManagedCandidate 核原审计、真实读取及完整 managed tree 后原节点结算。

## 首轮失败与修正

完整工程 fixture 前两次因测试将冻结 schema 的文档名写成“技术方案.md”而在 inspect 失败；修正 fixture 为真实合同“修改方案.md”后通过，没有放宽产品 schema。日志保留 task-revision-real-flow-first.log、second.log、third.log。active restore 首次脚本把数据库 snake_case 行直接传给 camelCase store 接口导致无恢复项，已修正只读投影后四条 PASS。

## 可重复命令

PowerShell 在 worktree 设置 TEMP/TMP 为 docs/tmp，然后运行：

```powershell
node --test test/task-workflow-contracts.test.js
node --test --test-name-pattern '真实工程任务删除|任务工程副本增删|原生读取凭据|工程交付证明复用' test/workflow-engineering.test.js
node --test --test-name-pattern '无新增修改失败交回Owner' test/workflow-service.test.js
node docs/tmp/check-active-registry-restore.mjs
node docs/tmp/test-sg18-native-read-proof.mjs
```

日志与只读证明在 docs/tmp，本轮未创建完整历史副本。没有宣称真实后端/UAT验收、真实GitHub发布或钉钉送达通过。
