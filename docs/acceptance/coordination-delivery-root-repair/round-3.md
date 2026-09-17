# Round 3：正式本地部署与真实页面

## 部署前保护

- 对当前 v7 存储执行只读结构检查：groups=1、scheduler=1、tasks=47、alerts=71、activities=7555，invalidRecords=0、strippedFields=0、unknownTables=0。
- 停止前确认 activeTasks=0；只停止同时占用 3080/18998 的旧 DSH 进程。
- 备份写入 `C:\Users\64554\.dsh\backups\coordination-root-repair-20260911-2b486be\dingtalk_dsh_assistant.json`，大小 10,229,213 字节，备份 SHA-256 为 `C72DDC2E8DF686B841FED36CCD5B78EE6884D0D52DA3F92935BC7FDC35C846CD`。

## 正式安装与运行态回读

- Assistant tgz：137,633 字节，SHA-256 `7925E6FC26C6C0CD0D5780E1172100FEC803765A59028A96BCA82098A546174C`。
- Observer tgz：19,644 字节，SHA-256 `575541AACFCE6B3837A1CD3060EEFF0D3CF04270EDA181C2D1C1A4BAED32C39F`。
- 通过正式 profile CLI 安装；profile 依赖路径回读为上述两个 tgz，已安装 `runtime.js`、`store.js`、`topic-runtime.js` 和两个 Web client 与源码 SHA 一致。
- 新 Node 进程 PID 887396 同时监听 `127.0.0.1:3080` 与 `127.0.0.1:18998`。
- 健康接口回读：`healthStatus=ok`、`recoveryIssueCount=0`、`transport=dws`、`inboundProcessing=true`、`dwsHealthy=true`、taskCount=47、activeTasks=0、taskPromptsVersion=8。部署前相同现场为 degraded、recoveryIssueCount=116。

## 真实页面

- 使用独立无头 Edge 打开正式本地实例，不复用用户浏览器标签页。
- 强制等待看板显示“运行正常”，再检查任务看板、人工介入列表及详情弹窗。
- 结果：`taskPageVisible=true`、`authorizationPageVisible=true`、`detailVisible=true`、`pageErrors=[]`。
- 详情中“批准该事项并继续”可见；未点击批准/拒绝，未重放任何历史消息。
- 首次脚本曾在首轮加载完成前命中空态；这属于测试时序缺陷。脚本已改为以运行态和真实行出现作为门禁，复跑通过，不将错误空态计作产品结论。

## 结论

Round 3 全部通过。正式本地实例已加载修复版本，22 项矩阵保持全绿；真实钉钉外发未执行，不能据此声称历史消息已重新投递。
