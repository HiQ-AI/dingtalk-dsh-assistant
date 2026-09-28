# 业务闭环与交付包

最终定向命令：

```powershell
node --test test/dws-file-adapter.test.js test/dws-adapter.test.js test/task-artifact-files.test.js test/task-artifact-write.test.js test/task-general-workflow.test.js test/task-group-file-delivery.test.js test/task-group-file-runtime.test.js test/workflow-file-delivery-integration.test.js test/execution-message-delivery.test.js test/task-owner-store.test.js test/message-workflow.test.js test/task-owner-session-native.test.js test/message-answer-cancel.test.js
```

171/171 通过，0 fail、0 skipped。业务集成使用真实消息接纳、Owner 控制、SQLite、能力步骤、Delivery 和完成门禁；模型决策及渠道为受控替身。验证文本生成→文件发送→核验后完成、已有 PNG 导入→发送→完成，以及仅写文件不能完成。真实 DWS 渠道单独在前三轮核验，不将这两层合称真实模型端到端验收。

Owner Store 原先禁止已成功生成阶段直接追加文件交付，导致目标未满足又不能推进；现在仅允许 Host 已授权的单个文件交付阶段延续原需求。完成判断逐件核对产物、需求版本、群、profile、消息资源、大小和 SHA；pending 的精确出站身份仅用于过滤回声，不冒充字节核验。

已有二进制导入仅接收 `role/fileName/relativePath`，Host 根及白名单来自 `generalFileRead`；任务范围再核对路径和必交项。预备只读冻结实际摘要，执行才登记，源变化拒绝，恢复仅查询受管快照。源与目标扩展名必须一致，不代表验证 Office/PDF 内部格式或具备这些格式的生成器。

后续修改造成的旧 fixture 回归已修正：仅显式 fileTransport 时才从 suppliedExecution 提取产物根。`node --test --test-name-pattern '专业分析后|方案阶段完成后|阶段间取消' test/workflow-service.test.js`，3/3 通过。

`node scripts/build-web-client.mjs` 通过，生成 Web 文件无语义 diff。本次可读展示复用既有输出组件，通过服务投影测试验证，没有浏览器 UI 验收。

`pnpm --filter @zzusp/dingtalk-dsh-assistant pack --pack-destination <当前检出>/docs/tmp/task-group-file-delivery` 通过。独立解包核对受管文件、写入/导入、群发送、工作流服务、Resident 与 Delivery 七个源码文件摘要全部一致。

包：574307 字节，SHA-256 `ac3fe1cf43a179c308f1b568df213f600b496b4ef07f1640822d14063e1af8ed`。这是本地验证包，版本保持 0.5.15；没有发版、合并或安装到正式实例。
