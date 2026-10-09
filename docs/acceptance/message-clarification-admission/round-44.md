# Round 44：部署检查裁剪 Host 验证目录可再生依赖

结论：原规则遗漏 Host checks/verify-* 中的 node_modules，已按既有任务工程目录形状精确补齐。未修改快照、数据库、运行实例或正在执行的旧 checker。

证据：scripts/deployment-integrity.mjs:14-15 原规则仅 ws-64hex/repository；files 枚举在不匹配时递归。execution-check-job.js:48 用 mkdtemp(root/verify-)创建六位后缀验证目录，workflow-engineering.js 的验证根是 managedRoot/checks。

新增剪枝仅匹配 `<logicalTaskId>/work/engineering/<24-hex>/checks/verify-<6-alphanumeric>/**/node_modules`。复用既有容量统计/复制/源清单检查，不进入依赖链接。artifact引用闭包、所有源码/产物和其他链接规则不变。运维说明仅更新既有依赖排除段，不改变普通部署无历史备份及包 SHA 核验流程。

## 验证

PowerShell TEMP/TMP 指向 docs/tmp/authorization-state-tests。

```powershell
node --test test/deployment-integrity.test.js
```

40/40 PASS，12.50秒。新增两例根/嵌套依赖剪枝，复制后源码与result.json仍在；两例同时损坏正式任务artifact后均拒绝。五个负例：dist链接、source链接、不匹配verify名称、非verify检查目录、非checks位置，均继续拒绝。既有WAL、完整闭包、其他链接、清理历史、备份复核用例全部通过。

本轮 scripts/deployment-integrity.mjs、test/deployment-integrity.test.js 与ops说明 git diff --check通过。未提交或触发现场checker；新规则仅后续新进程调用生效。
