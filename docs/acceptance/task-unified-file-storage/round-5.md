# 第五轮：正式部署与迁移（进行中）

上线预检 `deploy-owner-repair.ps1 -Check` 退出0：writes=0，online=true，21个历史任务；包99文件摘要匹配，SHA256 fbbb0c96df4796188d62a6a01a8b50912c5607b434057a630288e938d635b20d。D盘可用15360720896字节，预检所需2609739724字节。

实际API确认 dataset task-web-cf7... 和 Editor task-web-491... 均 state=completed/outcome=succeeded，逻辑身份分别为 task-af34f1d5c616a1227a35fc3de58e70ad、task-d2aa74700cc586d8c60f840d12e1a61f；执行历史分别3轮和4轮。计划239 entries只进入这两个任务根，源仅选定runtime-v2受管路径，expectedManifestDigest=9da9d79b29dda44da56c2ca70981f06350c565753aeaad606e1a0c088ee0e93b。

正式执行使用 HoldMaintenance。原PID2368已停止，维护封存记录保存在私有 docs/tmp/task-unified-live-deploy-20260929；原备份 owner-repair-20260929-164052-468 已完成，迁移源独立sibling普通副本正在生成。工具SHA冻结948f57a6cde7c6d85587098489f262a1fdcd1ffc7da49e0e435bd4fee30917dc。

原始会话配置根 D:/dsh_home/sessions 不动；执行前仅1个文件、517字节，已私有记录摘要。两个任务六个指定历史会话文件未找到，保持missing，不声称这些日志已备份。任务引用范围之外未发现已证实私有文件遗漏，但未重建完整原始工具历史，无法排除无引用无标识的散落文件。

## 待独立回读

- 迁移独立备份及journal全文件摘要/同inode。
- 两个任务历史和候选身份、旧引用继续可读。
- 新PID/包/健康，维护恢复后真实群任务和附件下载。
- 实际重启后文件与API可读。

独立迁移源备份完成并回读：18368 files / 773430821 bytes，普通副本独立inode，全项SHA验证；manifest SHA256 4a191e5222521a4ab89dddb732fc499573705dcef1f6de4bb707338a883e11ed。迁移journal已fsync落盘（13150108字节），执行仍进行中，未写PASS。

## 迁移与安装读回通过

两任务根已收纳14965/3403个文件，合计18368/773430821字节。独立四并发流式核验全部新旧路径SHA、大小、inode/device及nlink>=2均通过；证据 private docs/tmp/task-file-link-migration/independent-proof.json。程序自身execute及后续verify也全项通过。

两任务旧冻结candidate分别1个，真实Git树2657/997源码文件，readCandidate保持原绝对路径身份且样本字节读取通过。实际API迁移后与前：state=completed/outcome=succeeded、结果正文、执行轮次3/4、全部outputRef一致；真实旧节点output API可读，Editor早期失败历史保留。

精确包安装读回99文件/SHA匹配，新双端口PID41948。健康ok、recoveryIssueCount=0；已验证token交换303、认证Web200，并在独立msedge无头浏览器打开真实看板及详情，pageErrors=0。原始会话基线1文件517字节大小及SHA不变。

受控部署ready=true，但businessAcceptancePassed=false。这只证明安装及控制面读取，真实模型及钉钉附件路径尚待验证。用户已明确允许使用现有专用验收群，经同profile唯一群搜索count=1、complete=true确认；不在业务群发测试任务。
