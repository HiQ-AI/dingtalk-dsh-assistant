# Round 81：SG22 当前候选 UI 验收与可登记配置

## 实际结论

验收工具可正式登记；原 gen7 候选没有通过。真实 HTTP 服务与 headless Edge 加载当前组件，报告 `ACTIVITY_MERGE_CANDIDATE_RENDER_FAILED`：Detail 模板引用 `RELEASE_PHASE.MERGE_RESULT`，实际 Vue 实例未暴露 RELEASE_PHASE。原候选六文件 SHA 及截图/ledger 已写同Task共享材料，明确是人工 Host 诊断，不是执行节点回执。没有修改业务候选。

## Runner 修订

沿现有 `scripts/local-acceptance-activity-merge.mjs`，从当前候选 AST 读取 activityMergeResults、handleActivityMergeResult、相关真实 data/computed/method。没有旧新 fallback，不为原组件注入缺失常量。执行前验证实际服务 `/ready` 的 Task、namespace、六文件SHA；浏览器真实请求页面及assets，只将业务API明确替换为fixture。取消旧客户端 status 可信导出断言，含该字段的请求被拒；不猜测尚未产出的后端 resultId 契约。

## 验证分层

- 原生参数/namespace/loopback/prepare运行时用例：4/4 PASS，`docs/tmp/sg22-current-runner-tests.log`。
- 实际 gen7 候选：FAIL，`docs/tmp/sg22-current-ui-render-proof.log`。初轮仅监听pageerror，Vue把错误写console导致8秒找不到按钮；加入真实console error采集后稳定报告原始渲染错误，不吞掉异常。
- docs/tmp隔离复制只为测试runner：仅补实例常量后继续FAIL，明确发现导出提交客户端status（`sg22-isolated-ui-fixture.log`）。再仅在该隔离fixture去掉客户端status，完整partial/all-failed、下载Blob及错误提示、取消/继续、全部成功/旧确认、无候选确认4分支PASS，`sg22-isolated-ui-positive.log`。不能把隔离修正的PASS当原候选PASS。
- cleanup确认浏览器已关闭、零业务写；HTTP server原生close退出。
- 持久内容址runner在原候选 `--check` PASS（仅语法/结构，不是渲染PASS）：`sg22-persistent-runner-check-rerun.log`。首命令误以候选cwd读取相对proposal路径而失败，修为绝对路径后实跑；没有写候选。

## 正式配置输入与零写核验

目录 `docs/tmp/sg22-ui-host-profile-ready/`：

- `bundle.json`：保留当前两repo全量localAcceptance。
- `mergePolicy.json`：保留当前Host UAT合并策略。
- `checksProposal.json`：保留当前dataset checks，无版本/命令调整。
- `repositoryPatches.json`：保留dataset-web原entries，仅追加SG22精确Task/UAT3/requestDigest。
- `proposal.json`：readyToApply=true指工具可用，不表示候选通过；单scenario返回backendVerified=false。

116工具文件（3脚本、2配置、Playwright 1.62.1包111文件）已按授权复制到 `D:/dsh_home/tools/<内容SHA>`，独立逐SHA回读全相等：`tools-installed-proof.json`。配置不引用临时工作树/测试副本依赖；复用已安装Node/Corepack Yarn。

`node docs/tmp/prepare-sg22-deployment-inputs.mjs` 调用真实配置器 `mode:check` 与真实 `verifyPlannedEngineeringConfig`：writes=0，原profile SHA `3b5c562d4fea4ed95581698a90dbea4289d2b839dceb2c4dc68bbdbe34e628f6` 不变；计划SHA `2ef0dd33192a9a59cf3ee028391230ab22c33bb148e456ac058a6ecf7131b831`；唯一对象差异是所述task entry；5活跃定义摘要5/5兼容。见 `deployment-input-proof.json` 与 `docs/tmp/sg22-profile-native-check.log`。本agent没有apply profile或部署。

## 同Task诊断与真实后端限制

`D:/baibu-agent/tasks/task-f559fc2e93230cf2cdcd61c8ad51dc35/work/activity-merge-current-ui-host-proof.json`，req1，SHA `a750ae973a944933dba98db65ad54071a7e1af9835d356e13394bed584bef0cf`。原生Task共享目录读取能力可按 `work/activity-merge-current-ui-host-proof.json` 读取，关联outputs内截图/ledger。`sg22-ui-shared-proof-readback.log`独立回读确认，不发消息、不写控制账、不假Node结果。

后端依赖Run `run-b7198615cd06723b2ee9b443f3f99290308a52000399e5876e6ca055dc2e2867` 真实 inspect-and-propose仍running，尚无方案outputRef；只读证据 `sg22-backend-current-contract.json`。因此尚不能实现/声称真实Excel15列、最新数据/固定本次结果、身份权限与版本边界通过。UI部分必须保留backendVerified=false，后端原Task产出实际契约后继续接真实companion，不以预检或fixture代替完整业务交付。

### 登记前补齐同套件多 criterion 回执复用

真实 v18 计划要求每条 criterion 一条 case；原Task三条criterion若引用同一UI套件，旧 started 单次门禁会拒绝第二条。工具保持浏览器只执行一次：首次完整 passed 后，后续同 namespace/baseUrl/configDigest/六源码SHA且真实service ready一致，仅读取已有actual回执；失败/未完成绝不复用。`sg22-isolated-ui-receipt.log`真实套件PASS且第二次回执一致；`sg22-ui-receipt-unit.log`4/4。未更改冻结packages或业务候选。

因此本轮**最终部署输入目录是 `docs/tmp/sg22-ui-host-profile-final/`**，取代上面的ready目录，四文件名不变。工具内容址 `111d14f22fe7c16aac03fd84e9beb070c370e000d9b3fab15e68ec6ec82b865f`；Playwright内容址沿用不重复复制。最终 `sg22-profile-final-native-check.log` / `final/deployment-input-proof.json`：116文件SHA一致、配置器writes0、5活跃定义兼容，原profile仍3b5c…，计划SHA变为 `d68f25bc91aee58c447816e40ff3bf7f5c7fa29b1825cb62cac47077f6635eb5`。旧ready输入与首次证据保留，不混用。
