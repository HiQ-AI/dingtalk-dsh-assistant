# 执行会话时长、单行布局与原生圆环验收

基线 origin/main `8c2cc77231d39bebfbfebe31113bebf1b44f4cd6`；分支 `feat/task-session-duration-preview`。仅修改任务卡片执行会话列表、必要计时/状态投影及对应测试文档；不含署名配置、skills、其他页面、相邻仓库或真实业务变更。用户已接受 alpha.2 原生圆环，并授权提交、推送及 Draft PR；不合并、不部署。

## 最终行为

- 左图标、中间名称、右纯时间值保持单行。名称超长 ellipsis 并提供完整 tooltip；不显示状态文字或“时长”前缀。缺失时间显示“—”，tooltip/无障碍标签说明缺少完整计时证据。
- 新动态执行由可信 Host 保存 runTiming；各次 execution.claim 至首次 execution.result 或 execution.drained 的区间累计，排队/续办等待不计，取消请求至实际排空仍计，结果后的收尾等待不计。
- 同一执行/会话续办保留累计值；终态固定、重复结果/排空不重复累计。历史无字段和重启时未闭合区间不补算，明确未知，不使用 createdAt 差值。无 schema 迁移及历史回填。详见 docs/spec/execution-session-duration.md。
- 仅 running 且非 drained/recovering 的执行调用已有宿主 StateDot ongoing，固定14px图标槽。其他状态沿用原图标，tooltip/a11y保留。DTO额外投影 drained/recovering 以排除恢复或已排空记录；计时逻辑独立。
- 直接复用当前依赖 `@deepseek-ai/dsh-client-ui-primitives@0.2.1-alpha.2` 的原生圆环，不升级依赖、不移植旧矩阵、不自行绘制动画。

## 验证分组（有交集，不相加）

1. 初轮累计计时/接口/界面定向组合：174项，172通过、0失败、2项因缺少完整原生DSH profile跳过。实际命令：`node --test test/dynamic-task-store.test.js test/task-session-http-integration.test.js test/client.test.js test/http.test.js test/observer-client.test.js test/observer-node-control-display.test.js test/observer-slot-compatibility.test.js test/observer-archive-interaction.test.js test/task-session-names-native.test.js`。见 tests.log。覆盖领取/排队、结果固定、排空、续办累计、取消、重启未知与历史缺字段。
2. 最终原生圆环/单行UI与DTO回归：53/53通过，0失败、0跳过。实际命令：`node --test test/observer-client.test.js test/observer-node-control-display.test.js test/observer-slot-compatibility.test.js test/observer-archive-interaction.test.js test/task-session-http-integration.test.js`。见 ui-tests.log；这是上一分组的定向重跑，不是额外53项独立覆盖。
3. `node docs/acceptance/task-session-duration/scripts/verify-browser.mjs`：16项检查通过，0控制台错误。桌面1440、390/320px真实DOM单行/无重叠/无溢出；名称省略及完整提示；时长增长、终态固定、排队/缺字段/未知；读取失败、空列表、键盘导航；实际活动执行才显示原生14px loader，双CSS动画确实随时间变化，reduced-motion停动，终态卸载且尺寸不变。见 preview/results.json。
4. 严格设计审计0错误0警告，见 premium-audit.json；`node --check packages/dingtalk-dsh-observer/web-client.js` 和 `git diff --check` 通过。observer直接提供该浏览器模块，无独立构建/类型检查/格式化脚本，未运行会写入其他页面的assistant bundle构建。

## 浏览器证据与边界

浏览器使用真实React和完整observer模块、只读合成API，拦截所有外部请求；从已安装bundle提取未经修改的StateDot/syncSpinner/pinSpinner函数及原生CSS，提供JSX runtime/clsx适配，其余宿主外壳为语义替身。版本与实现/CSS SHA256见preview/results.json.nativeEvidence。静态截图使用reduced-motion展示形状，运动由浏览器断言验证。

未验收：真实DSH宿主插件注册/原生会话集成、完整原生profile、模型凭据、真实钉钉业务与线上部署。frozen lockfile依赖下载完成；pnpm因未批准koffi构建脚本返回非零，未运行该脚本，未保留自动生成的配置。上述定向验证均实际通过。

## 预览附件

仓库保留 preview/desktop.png、narrow-320.png、narrow-390.png。Library桌面/320px均为原生圆环版本3：

- 桌面：library_file_id `libfile_5633cefd85a88191827c7f7117679bc8`；file_id `file_00000000f3d481f58089517879f15aeb`。
- 320px：library_file_id `libfile_982ced865bd48191a5d81cbb1e5f52c7`；file_id `file_0000000050048230a7ffd4a128da919a`。
