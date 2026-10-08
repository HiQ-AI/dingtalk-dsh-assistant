# 文档类型分流与原Task恢复

## 本地证据

- `node --test test/dws-bridge.test.js test/dws-adapter.test.js test/coordination-resources.test.js test/task-owner-session-native.test.js test/agent-query-tools.test.js`：155/155 PASS，3990 ms。
- Task资源范围与新旧消息：6/6 PASS，1707 ms。新旧消息均先创建Task，Owner独立双读后保存查询证据。
- 群会话原生测试：20/20 PASS，覆盖观察idle派生、重复准备同一child、下轮正常执行，以及活跃/维护中、额外输入、错误身份/lease、派生期间父事件改变拒绝。
- 真实私有inspect/download回执及57222字节HTML通过适配器离线重放，正文逐字相等、无HTML执行、临时目录清理；未用此代替Runtime业务证据。
- 现场旧协调会话持久谓词核验：cwd匹配、unsafeInputs=0、lastLease=59、尾部仅session/end-seed；唯一额外系统输入为SDK system-prompt snapshot。未取得外部Agent的dispose权限，修复只用公开idle维护锁及原生历史派生，保留外部Agent。

## 产物

最终候选包SHA256 `1ef6ed86e7bee3094dbd05b53f8c0ce0442681cb6aa1075279c2a17b706936e4`，包/源码100文件独立一致。部署及原Task正文证据待本轮后续读回。

## Runtime 独立回读

2026-10-08 14:02:04，原 Task `task-1edb9931ffe6ecd4efc0a3949376d66f` 实际调用 read-task-message-resource-v2 并持久化 agent-query-evidence。证据为 Task 工件 `sha256-92a25210481fb5fac1e800819a7ec547890a738a9266338576ac8b1f436e0518.json`（63220 字节），FILE/html 正文57222字节，sourceSha256为 `edc1b1b805cf37bed0bcf5e4984a419d903fc8c2a1cf523d162c38e414d026f1`。独立提取证据正文与原下载文件逐字和摘要一致。正文不入库。

安装包/源码/安装100文件一致，观察包4文件保持；新PID125252，maintenance inactive revision468，health ok，收信恢复，旧4个Task/30节点/1Run保留。原Task等待中不再缺文档，只缺UAT。四条真实环境讨论被第三人公共fact权限连带拒绝而另建话题，后续修复进入SG7；不把文档读取成功冒充业务开发完成。

原生观察会话交接分支仅测试验证；本轮现场新进程直接接续原协调会话lease60，未把此现场声称为实际派生验证。
