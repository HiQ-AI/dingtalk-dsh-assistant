# Round 53：生产活动合并结果专用 UI 验收

## 结论

验收脚本的独立 headless 自测通过；真实候选仍 FAIL，未部署、未修改正在运行的候选或数据库。不存在完整业务验收PASS。

## 实现及理由

旧review脚本专用于评审草稿，不能验证此功能。新增`scripts/local-acceptance-activity-merge.mjs`，复用候选Vue2.7、Element UI、原SFC模板/脚本/样式、Detail父模板AST中的真实组件绑定、原父方法及状态机。完整脚本原生解析先行，未偷偷修正真实候选。固定网络fixture限定本地测试页和精确路由，外网/WebSocket拒绝，测试中没有SSO或共享数据写入。Task/UAT3及namespace固定，关闭证明和ledger绑定后才能cleanup。

## 证据

- `node --test test/local-acceptance-activity-merge.test.js`：3 PASS，Task/UAT、namespace、重复执行、关闭状态、远程origin、任意case参数拒绝。日志`docs/tmp/activity-merge-ui-unit.log`。
- `node docs/tmp/activity-merge-ui-selftest.mjs`：真实候选首先`ACTIVITY_MERGE_CANDIDATE_SYNTAX`拒绝（Detail script行1412）；之后仅在`docs/tmp/activity-merge-ui-fixture`隔离副本添加缺失逗号验证验收器，4组实际headless交互PASS并verify-cleanup通过。该副本不是交付候选。日志`docs/tmp/activity-merge-ui-selftest.log`。
- UI：部分失败3/1/2、全组名称、保留成功提示；下载精确POST groups/selectedDatasetIds/status，真实download事件、Blob字节和文件名；无效文件显示错误；取消不生成且刷新。全失败3/0/3，继续进入原确认，确认前零生成、确认后一次生成；全成功旧成功提示及确认；无候选旧确认。
- 截图/ledger：`docs/tmp/activity-merge-ui-evidence/acceptance-0000000000000000000001a11b88761b/`。此前自测遇到Element表头固定列的隐藏checkbox，改为按真实组选择自动勾全量行为操作，不强制点击或伪造submit。
- 原候选只读失败：`docs/tmp/activity-merge-real-candidate-failure.json`，保留6个源文件SHA、具体语法位置。真实候选未修改。
- 后端：`docs/tmp/activity-merge-backend-route-proof.json`。冻结review伴随jar的VersionManageController不含结果导出或候选导出路由字面量；已查看的dataset main与same-name round8 UAT3源也未发现结果导出映射。此证据不代替远程UAT探测，但足以说明旧review配置不能证明本功能。

## 尚未通过

真实候选语法修复、真实后端POST结果导出权限及可信来源、实际Excel列/内容/样式，仍未通过。fixture下载字节只测UI Blob下载链路，不冒充后端生成Excel或合并结果持久化。Task scope正确配置需要主代理按受管checkpoint安装；此轮不改现场配置。

## 原Owner的最小后续修复

1. 原dataset-web候选Detail.vue方法分隔符须由原工程任务纠正，再复验候选；此脚本不代改业务工作区。
2. 当前工程stage仅dataset-web，新增前端API函数不能产生Java接口。原Task计划需增加dataset工程stage，或引用独立已核验的正确后端构建；实现`POST /versionManage/{versionId}/activity-merge-result/export`，验证登录租户/版本及合并结果可信来源，不接受客户端status充当成功事实，并生成PRD要求的Excel内容。后端现有候选导出不能替代结果导出。
3. 沿现有`localAcceptance.companionServices`替换dataset的`artifactPath`、`artifactSha256`和同一`-jar`参数，沿现有`prepare-web/serve-web`本地proxy绑定，不加readiness框架。正确Task/UAT3专属scenario须另补真实后端下载/Excel断言；UI fixture只作一个分层用例。
4. 原Task scope checkpoint更新localAcceptance配置，保留当前正确checks及成功候选前缀。离线提案`docs/tmp/activity-merge-uat3-configuration-proposal.json`明确`readyToApply:false`，不能直接用UI-only草稿宣布业务任务完成。`activity-merge-uat3-config.json`只含此UI脚本的Task/UAT3固定配置。
