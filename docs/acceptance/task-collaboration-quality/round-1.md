# 第1轮：实现与确定性验证

基线：192e808。代码、测试、真实模型样本、安装运行态分开判断；本轮不操作现场任务。

## 已验证

- `node --test test/dynamic-task-store.test.js test/task-execution-timeline.test.js test/model-context.test.js test/client.test.js test/http.test.js test/observer-client.test.js test/observer-node-control-display.test.js test/observer-slot-compatibility.test.js test/web-client-build.test.js`：220 PASS、0 FAIL、1 SKIP。跳过为默认未指定完整原生客户端profile，后以已安装web profile单独运行官方客户端导入合同，1 PASS、0 SKIP。见 `round-1/data-and-ui.log`、`round-1/client-installed-profile.log`。
- 仓库锁定原生profile，定向 `task-session-service-native.test.js`：9 PASS、0 SKIP，覆盖双委派先于wait、交接/资源、原会话续办、固定产物独立只读核验、容量和资源队列。见 `round-2-native-collaboration.log`。脚本模型证明机制，不能证明模型自行选择。
- 仓库锁定原生profile，`task-session-progress-native.test.js task-session-skills-native.test.js task-execution-resources-native.test.js`：12 PASS、0 SKIP。见 `round-1/existing-contracts-profile.log`。
- 仓库锁定原生profile，`task-stage-progress-native.test.js`：3 PASS、0 SKIP，覆盖恢复、人工等待和新阶段活动/证据投影。见 `round-4-stage-native.log`。
- `pnpm test:release-smoke`：14 PASS、0 SKIP，实际tarball提取、个人技能任务和独立resident健康。见 `round-1/release-smoke.log`。最终统筹文案最后收窄后另补最终打包核验，不把此前产物说成最终候选。
- `node scripts/test-suites.mjs check`：299文件完整映射，无删除，3历史文件；无映射修改。
- premium strict audit：0 finding，见 `round-1/ui-audit.json`。

## 浏览器

复用 `docs/acceptance/task-review-results/browser.mjs`，增加显式浏览器参数以在Windows运行；React、实际Observer组件与CSS，任务数据为合成，decision API由本地浏览器路由模拟，不访问真实业务。

```powershell
node docs/acceptance/task-review-results/browser.mjs <playwright工具根> docs/tmp/task-collaboration-browser-round-2 <浏览器exe> <React依赖根>
```

已观察：成果依据链接可读、javascript文本不成为链接、报告时活动不冒充当前动作、长证据390px无页面横溢；键盘Enter可展开明细；加载保留成果、空态可见、分页失败保留4条原记录且可重试。见 `round-1/browser-states.log`。截图仅保留docs/tmp，不提交大binary。没有修复前浏览器截图；修复前证据丢失由原代码投影与新增回归确认，不编造视觉对照。

## 失败及修正

- 首次原生回归未设置DSH_NATIVE_TEST_PROFILE，11项跳过，不能算通过；设置仓库隔离profile后12/12通过。原日志 `round-1/existing-contracts.log` 保留。
- 新独立核验测试首次错误排除了正常model_content_read；修为只允许model_content_read/read/execution_submit，同时严格断言实际文件read与提交各一次、总写入效果仅一次。首错保留 `round-1-native-collaboration.log`。
- stage恢复测试原自定义Provider未声明low推理能力，统筹预检失败、从未创建执行；补真实能力声明及精确诊断，没有删断言或修改生产恢复。见 `round-3-stage-diagnostic.log` 与最终 `round-4-stage-native.log`。
- 官方client在锁定最小profile缺client-modules，单独用已安装web profile核验通过。该运行只启动测试Context，不修改已安装实例。
- 真实模型探索轮发现合成result/wake/资源合同偏差及合法直接文件读取被隔离护栏拒绝。全部首错与输出保留docs/tmp，不能算产品行为最终PASS。下一轮改用生产Store及固定单文件隔离，全7例重跑并独立语义审阅。
