# Round 52：两原工程任务只读检查

两任务均沿原Run处于verify-candidate，无waitReason。实际进程表证实dataset Java执行test-compile和Surefire（skipTests=false、failIfNoTests=true），dataset-web执行Vue生产构建；不是仅页面running。此时未宣称检查通过、PR已创建或业务已交付。

发现后续本地验收配置串任务：
- task-1edb9931ffe6ecd4efc0a3949376d66f：uat2数据集导入导出，冻结scenario却为merge-normalization，version为uat3-merge-a9087af648c6。分支HiQ-AI/dataset的codex/task-e6a6723b000fd34e59306d74。
- task-f559fc2e93230cf2cdcd61c8ad51dc35：uat3生产活动合并提示，冻结scenario却为review-opinion-draft，version为uat2-review-a880a2569cc5-a910900644da。分支HiQ-AI/dataset-web的codex/task-655e1728aaecc9175afffb44。

证据：只读DatabaseSync读取当前execution_runs.workflow_digest，再按message_workflows.digest取body.config；精简结果docs/tmp/round52-registered-config-summary.json。workflow-engineering.js新建703、后续780从repo级localAcceptance复制，391据冻结配置构造runner。应在运行本地验收前将验收配置与当前Task需求/环境绑定，不能以其他任务场景证明通过。已向主线程和工程代理报告，由其协调最小受管修复；本次未改候选仓库、正在运行脚本、控制库或业务源，不取消/重建任务。

## 受管修复代码及前置反例

registry支持local-acceptance checkpoint，完整配置与localAcceptanceScope（Task、UAT、当前request+criteria摘要）精确匹配后生成新定义；恢复时复核绑定，保留原checks。已绑定配置在重建时不再被仓库其他任务配置静默覆盖。Store/controller同代选择性重算define/plan由工程代理实现并另验。

共享原Task work/engineering-transfer-api-gap-round52.json已独立回读3616字节；明确Host诊断而非用户授权，req2，引用原proposal及实际Controller SHA。原proposal只改后台开关，尚无业务完成证明。现有ProcessDraftController只见整模板/import，不存在独立UPR导出/替换映射。

scripts/check-dataset-transfer-contract.mjs是只读前置诊断，不是完整业务验收runner；--check实跑真实checks候选，返回ready=false/passed=false及FR02、FR04缺口。即便源码新增映射仍不自动PASS，必须随后实现专属fixture和真实运行断言。不能据静态检查声明业务完成。

定向测试round52-registry-3.log：共享材料/checkpoint、共享UAT锁、真实前置反例3 PASS；额外原有重执行测试FAIL于Windows子进程spawn的ENOTCONN。独立单例复跑round52-reissue-retry.log仍同错误，未伪报全绿；未更改运行时/绕过测试。之前更窄registry范围round52-registry-2.log为2 PASS。当前完整业务脚本及原任务交付仍未完成，交回主线程沿原Task修复。

## SG18共享材料参数恢复

原生session 7a476625-c090-4639-a582-1e70eb66fecc只读证据：seq119的engineering_repo_inspect明确materials/source=previous及同Task SHA引用，seq120 sole ENGINEERING_READ_SCOPE_INVALID，seq122 blocked。修复合法误用为invalid_source/QUERY_ARGUMENT_INVALID + suggestedCall source=current；实际scope缺失/跨Task保持拒绝。旧分类仅精确匹配该组合、无提交/额外错误/额外输入才能受管恢复，其他scope错误不放宽。

实跑定向12/12 PASS，包含真实原生Loop自行纠正同会话提交、registry实际材料读取及历史分类负例；execution-session-native全文件71/71 PASS、14.01秒。日志docs/tmp/clarification-tests/materials-source-correction.log和materials-source-native-all.log已独立回读。Store重分类白名单需同步允许此精确Host证明导出的QUERY_ARGUMENT_INVALID，已向主线程报告；未在现场恢复或部署。

补录工程代理独立结果：local checkpoint controller全文件81/81 PASS、28.65秒（docs/tmp/local-checkpoint-controller-final.log）；8例覆盖verified、verify-waiting、wrong-scope、stale-maintenance、stale-revision、planner-timeout、planner-invalid、local-started。此结果由工程代理实跑报告，本分支未重复全文件运行。

Store精确接线补齐：execution_tool_failed只新增允许Host证明导出的QUERY_ARGUMENT_INVALID，原node恢复列表已有该码，未扩大SCOPE_INVALID类别。controller定向2/2 PASS（materials重分类及原越界恢复反例）。实跑当前SQLite online backup隔离副本+原JSONL：同gen3/nodeRunId/lease1/inputDigest/session不变，正式重分类后node.recovery返回repairable=true、resume-agent；无模型执行、无线上写账。证据docs/tmp/clarification-tests/material-source-clone-result.json，独立回读。首轮副本打开因instanceId不符失败，改为读取副本原execution_meta.instance_id后成功，未放宽生产校验。源码冻结。

repair可发现新增共享材料：复用readTaskMaterials，仅返回顶层sharedFiles元信息及materials/source=current读取提示，不返回正文或整历史entries。定向registry真实文件用例1/1 PASS，日志repair-shared-files-final.log。未修改其他执行核心或业务源；冻结。

任务需求优先闭环：新增精确taskLocalAcceptance选择，列表存在时跨Task/错UAT/旧摘要均拒绝，不回退repo默认。原生提示明确真实需求正文和UAT锁高于默认验收说明，禁止凭测试场景额外索要真人确认；repair直接返回taskRequirement核对。定向3/3 PASS（task-acceptance-scope-2.log）。初次测试因新增函数测试import缺失FAIL已保留scope.log，补import后实跑。原冻结workflow工厂未修改，既有Run仍需checkpoint。SG18完整FR01–06及SG20七项交互的业务执行验收尚未完成，此处不声称真实业务通过。

### SG20 七项候选组件验收（真实浏览器，独立生命周期）

- 脚本：`scripts/local-acceptance-dataset-merge-ui.mjs`；新建原因是现有 activity/review 场景与本 Task 七项交互不同，不能继续错绑。
- 候选：Task83 gen4 `checks/verify-f0g2jS`；result.json 保存十个真实源码 SHA256，不改业务候选。
- 七项已实跑 PASS：首次选择回填且保留过滤/不覆盖；步骤二产量权重列相邻及恢复默认；折叠面板展开/重入收起；两 tab 固定控件宽度及窄屏筛选区横向滚动；步骤状态/24px 圆/14px 字号；提示可关闭且不要求已计算；短/长/多行说明顶部与单位对齐、等距、参考产品无拆分。
- `docs/tmp/sg20-ui-round52-attempt4/result.json`：7/7，pageErrors 0。首次三次记录保留：sass 旧版调用不匹配、fixture JS 引号错误、测试字段/滚动容器适配错误；均修测试脚本，未修改候选。
- 完整 runner --check → initialize → execute → cleanup → verify-cleanup 全部实际通过：`docs/tmp/clarification-tests/sg20-ui-lifecycle.log`；最终截图与结果在 `docs/tmp/sg20-ui-round52-lifecycle/acceptance-52aabbcc001122334455667788990011/`。
- 定向 Node 测试 `node --test test/local-acceptance-dataset-merge-ui.test.js`：2/2，覆盖 Task/UAT 拒绝、namespace 身份与零写清理、重复初始化拒绝。
- 边界：API/列表输入是 fixture，未向后端发送业务请求，输出 `backendVerified:false`。七项交互可由此断言，但不能称后端功能/UAT 真实业务完成。
- 之前 reissue 两次 Windows 子进程 ENOTCONN 原日志保留；父代理隔离同例实跑 1/1 PASS、40.7s，未复现。没有据此宣称 OS 根因已定位，也未增加兜底。

最终脚本冻结复跑：补齐浏览器实际关闭状态后，完整五阶段生命周期再次通过。日志 `docs/tmp/clarification-tests/sg20-ui-freeze.log`；7/7 和 browserClosed=true 的结果在 `docs/tmp/sg20-ui-round52-freeze/acceptance-52aabbcc001122334455667788990033/result.json`。最终 Node 定向 2/2 PASS（153.6ms）。未部署、未更改 Assistant 冻结源码或业务候选。

SG18 未完成边界：现有 `/process/excelImportUpr/{dataAttribution}/{processId}` 可作为工作区覆盖入口、`/processDraft/saveOrSubmit` 有整份快照/CAS；当前没有证据证明草稿 UPR 文件导入/导出的最终调用合同，且 UPR 既有导出由前端 ProcessData.exportProcessData 浏览器 XLSX 生成单个当前工序 Sheet，不能假定是后端 URL。不能将缺失合同硬编成新 URL 反向约束业务实现。本轮没有新增假接口/假 PASS 的 SG18 完整 runner，FR01–06 完整场景仍未收敛，必须待原 Owner 交付实际实现与调用合同后继续。
