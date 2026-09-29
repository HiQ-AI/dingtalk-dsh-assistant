# 第九轮：修复包本地部署与实际模型验收

服务源码修复、受控修复安装、实际模型正反例及正式入站/派发恢复已通过。本轮沿用第八轮完整备份及原封存许可，没有SQL修改、数据库回退或配置变更。

## 本地验证

- `node --test test/workflow-service.test.js`：149/149 PASS，0 FAIL/0 SKIP，109498.1105 ms，见 `round-9/workflow-service.log`。包含真实SQLite取消历史保留、活动/暂停未知旧定义仍阻断的三个反例。
- `node --test test/deployment-integrity.test.js`：14/14 PASS，见 `round-9/offline-backup-final.log`。备份损坏、业务文件/工件新增、非空WAL均拒绝。
- `pwsh -NoProfile -File test/deploy-owner-repair.test.ps1`：全部断言通过，含新增8个封存许可用例，见 `round-9/offline-repair-final.log`。
- 离线修复 `-Check`：writes=0，21任务/76旧节点/27终态Run/68legacy摘要不变，备份2374文件/28表/815工件引用。执行持EXCLUSIVE锁，原生plugin add安装后97文件字节与源码/tgz一致。

## 安装与模型证据

Assistant 0.5.15包598519字节，SHA256 `0407118f188537bb0f89e5ee7648e3bc0b7a5a2f37049266c66990614aac70be`；配置SHA256仍为 `5d3e9c333eb33f9a38971e1485f2858ede87e810f7ece49def12c88701fc933f`。安装后PID13688成功启动，认证Web 303→200、recoveryIssueCount=0；首次启动回读暂为degraded/inboundProcessing=false；后续确认degraded来自DWS消费者未就绪，不能将其归因于维护状态。

实际已安装Codex Connect/LLM，当前模型 `openai-codex/gpt-6-sol`、reasoningEffort=low。在全新隔离SQLite/工件/文件目录执行两条路径：

1. 调查明确故障未修复，仅实际保存备忘录；模型返回完整逐项 `unsatisfied/resultVerified=false`，强制完成候选被Owner拒绝，完成清单为空。
2. 目标为调查记录保存；实际文件字节与执行摘要核验后，模型返回完整逐项 `satisfied/resultVerified=true`，Owner应用完成决定，Host业务清单accepted且保存规则摘要，重开SQLite后Owner和清单一致。

实际模型两条用例PASS，不是模型流夹具；调查输出和Owner候选仍是固定夹具，因此不声明完整真实调查/Owner会话或任意自然语言质量评估。证据见 `round-9/local-deployment.json`；无钉钉外发、共享业务库调用或真实部署资源操作。

正式HTTP拒绝33条验收/空白条件，均400/web_task_request_invalid；任务卡片78→78，零增量。目录调查v6、投递v2读回通过。物理任务身份21与合并卡片78分开核验，不以卡片数替代原库身份。

## 环境恢复

C盘剩余0造成DWS本地审计写入失败，消费者重连；登录/网络只读检查正常。将本项目346个workflow-service-*测试临时目录迁移到本轮D盘docs/tmp留档，1267文件逐一SHA256核验，删除文件0。DWS单聊及一群监听恢复ready，另一群保留既有冷却保护并等待原预算自动重试，不清空保护状态或创建诊断订阅。

原始任务快照、查询提案、登录日志、DWS身份及临时迁移映射均只保留docs/tmp，禁止提交。完整备份仍在 `D:/dsh_home/backups/owner-repair-20260929-111951-779`；本轮不合并PR、不发布版本。
## 正式恢复回读

DWS原冷却保护自然结束后，两群listener=ready/backfill=ok，humanReplies=ready、dwsBridge.healthy=true。未手改订阅保护或创建诊断订阅。使用相同包/配置摘要及新launch执行正式 -Resume，maintenance.active=false、dispatchResumed=true，PID仍为13688，/health=ok、inboundProcessing=true、recoveryIssueCount=0，认证Web303→200。见 round-9/resume.json；部署源码提交4fb37030aeeb0b6269500ccff6d68ae0ed4ad113，与tgz及97个已安装文件独立字节核对一致。

解除维护后27.6秒独立回读：同一PID13688/Node24.19.0监听3080与18998，健康ok、恢复0、派发恢复、全部DWS监听ready及回补ok。实际入参脚本再跑仍400/零任务增量。见 round-9/delayed-runtime.json 和 online-after-resume.json。C盘余量38,653,952字节（约37MiB），运行已恢复，但本轮未扩大为整盘清理。
