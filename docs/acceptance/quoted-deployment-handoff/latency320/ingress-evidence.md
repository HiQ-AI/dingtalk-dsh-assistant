# SG5 入站时钟取证与细分验证

历史 135,405ms 的精确耗时归因仍未收敛。本轮改进是补齐后续可判定证据，保留原有同步接纳顺序；不将阶段异步挪动伪装成提速，也不重放现场消息。

## 历史证据与候选

- 接收 2026-10-27T05:30:35.267Z，ingress 截止 05:32:50.672Z。
- 91098B 归一化附件创建 05:32:42.786Z，是接收后约127.519秒；文件创建只能界定发布时点，不能证明127秒都耗在网络。
- 四个活跃原生会话同时出现长事件空档，集中在05:32:41—05:32:48Z恢复；见 historical-clock-summary.json。这支持共享Host阶段受阻，但不证明具体调用或整个窗口都被冻结。

| 候选 | 证据与反证 | 判断 |
| --- | --- | --- |
| DWS启动/网络 | 默认30秒JS超时且无重试；当前同图实际读取1.8秒左右。事件循环若停顿会延迟超时，因此30秒不是严格壁钟上界；当前正常不证明历史正常 | 未排除，缺历史命令起止 |
| 图片准备/提交 | 单独冷准备实测4.609秒、事件循环最大延迟4.551秒；原生Host初始化后的同图save为331ms | 可证明存在数秒准备停顿，不能解释完整135秒 |
| Host共享同步工作/存储/调度 | 多会话同期缺口；相邻操作体为KB级，source/receipt查询走主键，相关路径未发现全170万receipt扫描 | 共享停顿有迹象，具体阻塞调用缺trace，9GB库大小不是归因证据 |

## 本轮实现

- `ingestTaskResidentMessage`增加仅Host传入的`onPhase`，每图片资源记录resource-read，image-save涵盖准备与提交，resident-store涵盖原群串行队列等待。
- service原位采集source-read/source-record，保留整体ingress；每轮monitorEventLoopDelay在finally停止。仅存在采样时保存outer loopDelayMs，缺字段不冒充零延迟。指标属于共享事件循环，不能单独归因该消息。
- 精确sourceId已知，直接记录细分span，避免每span重复source.list；失败时保留既有时钟诊断语义，不阻断业务接纳。
- 白名单显式校验phase枚举、仅outer ingress可有非负有限loopDelayMs；旧span identity比较保持原规则。DTO和详情展示保留外层及子阶段，不相加，不保存媒体ID/正文/凭据。

## 同一实际图片的隔离原生接纳

`native-ingress-probe.mjs`使用当前生产ingest函数、真实nativeTaskHost插件、真实DWS profile/runner读取该media，并经ctx.attachments.saveImages及真实residentStore写入docs/tmp下的隔离实例；未写现场任务或发送消息。证据为`native-ingress-probe.json`。

2026-10-27T05:57:33.105Z—05:57:35.228Z：

| 时钟 | ms |
| --- | ---: |
| 调用壁钟 | 2149.596 |
| ingress整体 | 2123 |
| source-read | 1 |
| resource-read | 1738 |
| image-save | 331 |
| resident-store | 22 |
| source-record | 26 |
| outer事件循环最大采样延迟 | 183.108 |

输出摘要为sha256:256569caee3a1187f2376b56c6ab56ad40c22e0f79449f629e310baa7b44c98d，91098B、1275×970，与现场归一化附件相同。此为当前环境实测，不代表历史135秒已修复；此前独立冷准备和当前真实Host初始化条件不同，不比较为优化提速。

## 验证

- `node --test test/task-message-projections.test.js test/dynamic-task-store.test.js`：148通过，0失败（phase-tests.log）。涵盖失败读取、重试成功、并发resident-store等待、白名单与重启身份。
- 新增DTO断言后单跑projection：21通过（phase-projection-final.log）。
- 实际native profile下`node --test --test-name-pattern='入站细分时钟' test/task-session-service-native.test.js`：1通过，0失败、0跳过（phase-native-tests.log）。真实附件及存储：首轮下载失败、次轮新版本成功、重复投影原时钟不变。
- 实际native profile下`node --test test/observer-client.test.js test/web-client-build.test.js`：35通过，0失败、0跳过（phase-ui-tests.log）。包含中文子阶段、外层采样展示与官方client资源加载。
- git diff --check无错误。未部署、未运行CI、未修改goal或提交。

调试过程曾因不完整PNG夹具和脚本模型未提交归类造成失败/超时，已分别复用仓库已有有效PNG夹具、返回明确ignoredRefs完成路由后原20秒门限重跑通过；没有提高超时或删除断言。
