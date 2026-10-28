# 第7轮：任务目录源头权限准备

2026-10-28，用户明确要求“别只修复本次”“目录为什么还要授权，放开权限”。统一范围为当前Agent工作区的tasks根及其可继承后代，不再逐目录审批。

## 结论与证据

- 原目录权限不足已证实：原生诊断WRITE_OWNER=false；官方单目录补权不带OI/CI，不能保障未来mkdir。业务授权仍有效，原Owner工具目录实际包含task_delegate而未尝试，不能把pwsh grantWrite失败判断成委派缺失。
- 新脚本仅添加当前用户OI/CI FullControl，先零写Check、ACL摘要CAS、保存原DACL、独立读回；保留owner、deny、其他SID和保护标志。新增独立文件的理由：现有官方修复仅处理精确目录，没有根继承准备入口。
- `node --test test/prepare-task-directories.test.js`：1/1通过，11.76秒，覆盖零写、CAS、继承、幂等、保护子目录、其他SID/deny/owner保留及非法根/junction拒绝；foreign-owner为隔离guard断言，没有改真实owner。
- 正式D:/baibu-agent/tasks已执行Check和CAS Apply，独立读回当前SID可继承FullControl，WRITE_DAC/WRITE_OWNER均true；再次Check needsChange=false。变更后DACL摘要47a07f2ba1a528060441083fd2f1b5eb6322e149cd1864f7a8aa92bdec8cf8f6。证据docs/tmp/coordination-mode-fix-20261028/task-root-inheritance-apply/{before,after}.json及task-root-inheritance-independent.json。
- 真实原生AclSandbox：原outputs与新建后代各自目录内Set-Content exit0；目录外同命令exit1、无文件，探针清理。见original-confined-probe.json、new-directory-confined-probe.json。最初探针使用.NET静态方法被ConstrainedLanguage拒绝，改为原生PowerShell命令验证；不把该预期语言限制当ACL故障。
- 既有原生技术恢复定向用例1/1通过，增强真实委派回执及同execution续办不重跑断言。额外资源组两项超时，未全绿，未改断言或归因于本次提示；隔离runner已停止，不改正式Host。
- suite map更新并核验316文件逐文件唯一，历史3不变、删除0；新测试保守纳入release，后续compat lane轮转是现有算法结果，没有移出覆盖。

## 现场续办与边界

通过正式Task context入口追加已验证技术恢复事实，progressImpact=preserve、authorizationChange=none，需求/控制13/13保持，context15→16，原session/原Task保持，lease169/drained=false已真实接续。此时仅能证明Owner开始处理，不能声称UAT2已提交/发布或原execution已接收新输入。原生尾部仍在model_content_read及compaction，不追加重复唤醒。

目录权限即时生效，不需要重启。Owner提示修订仍待新包部署；原PR285本轮独立回读已MERGED，新修订使用独立分支。未触发CI，未重放业务消息或发布。受保护子目录/显式deny保留，未声称全树每个历史叶子均已放开。
