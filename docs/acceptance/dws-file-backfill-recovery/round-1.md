# 第一轮：根因与隔离验证

日期2026-09-30，基线 origin/main 50cfb89，独立工作目录 worktree-dws-backfill-conflict。

正式实例健康 degraded，首群回补报 WORKFLOW_EDIT_VERSION_REQUIRED。当天五条历史消息中一条文件卡片冲突，已保存119字符、回补87字符，同 ID、同发送者、版本1；仅多32字符固定DWS下载提示。精确 `dws chat +messages-mget` 独立回读 complete=true、foundCount=1、failedCount=0，消息/会话ID、正文、fileId均与历史回读一致。业务原文和配置证据只留本次docs/tmp，不提交。

## 最小反证

使用原始 workflow-service.js 运行新增双向文件卡片回归，两项均以 WORKFLOW_EDIT_VERSION_REQUIRED 失败。恢复修复源码后两项通过。发送者、文件名、资源ID、资源名、缺失/多个资源及追加业务要求的反例全部拒绝，不把任意同版本变化吞成重复。

## 实跑

- `node --test test/dws-bridge.test.js test/coordination-resources.test.js`：47 pass、0 fail，含资源恢复、历史下载元数据保留及固定提示严格校验。
- `node --test --test-name-pattern='文件卡片下载提示|无可信消息编辑版本|编辑|sourceVersion' test/workflow-service.test.js`：6 pass、0 fail，包含普通真实编辑、明确高版本和原任务取消回归。
- `git diff --check`：退出码0。
- `npm pack --pack-destination ../../docs/tmp/dws-backfill-conflict`：本地修复包1.0.0，非发布版本。持久包名 dingtalk-dsh-assistant-1.0.0-dws-file-backfill-20260930.tgz，611844字节，SHA256 b41100519064ccc74152cc4d51dc216e109a05a3d8f33148408381cb8c402948；独立 package 检查99文件通过。
- runbook部署脚本 `-Check`：writes=0、online=true、tasks=22；所需2695114038字节、可用21147860992字节。沿用原directQueries提案，权限及资源范围保持。正式维护只读回读：inactive、drained=true，nodes/owners/effects/messages均0。

下一轮按既有维护、封存、备份、安装和历史回读流程部署，待真实健康及回补恢复后才报告通过。
