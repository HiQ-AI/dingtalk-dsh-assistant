# 任务文件统一收纳最终验收报告

2026-09-29，本地正式实例上线验收及用户指定两个已完成任务的迁移已通过。原始会话目录保持原位。完整过程以 matrix.csv 为状态账，round-1 至 round-17 保留失败、修复和独立回读；本报告描述最终有效结果。

## 运行与真实业务

- 最终包 SHA256：b4b6e6054b6bed3153d07f7417c63350aa701d61a058ec5e35c0021a60c2d507，99个包/源码/安装文件相同。
- 新PID39624同时监听3080、18998。health ok，真实模型，inboundProcessing=true，recoveryIssueCount=0；维护inactive、派发恢复，计划任务未改变。
- 独立认证Web200/token交换303，独立msedge无头看板和详情通过，pageErrors=0。旧22tasks、76nodes、29runs、68legacy历史核验通过。
- 专用群“DSH端到端测试-20260927”真实任务 task-bf67e52908fd266fa6108536ad88b5ab 最终 completed/succeeded；Owner complete/applied、事件与处理水位137一致。
- 正式manifest按内容寻址引用独立读取并验证SHA：complete=true、missing=[]，businessValidation=accepted，7条验收条件、10个领域判断、文件1个。需求版本2、计划版本1、执行次数1和两个成功阶段保持，没有重发附件或人工改完成状态。
- 原报告消息 msgqHsb7xAweln/ntY0Cbjogg== 最终重新下载成功：324字节，SHA256 b145ad56ad680d1193a6ed6fa7fae0e4d7352e722a1915b1f53ee8891778753e。内容甲组3/1、乙组2/2，合计5/3/8、62.5%，仅用于上线验收的声明正确。新detailRevision下旧节点output API再次读回同一消息与摘要。

## 两个完成任务的迁移

| 任务 | 统一目录 | 文件数 | 历史回读 |
|---|---|---:|---|
| Dataset任务 | D:/baibu-agent/tasks/task-af34f1d5c616a1227a35fc3de58e70ad | 14965 | completed/succeeded；runSequence3、executionCount6、结果相等 |
| Editor任务 | D:/baibu-agent/tasks/task-d2aa74700cc586d8c60f840d12e1a61f | 3403 | completed/succeeded；runSequence4、executionCount7、结果相等 |

合计18368文件、773430821字节。迁移前独立普通副本备份，明确check/execute/verify/rollback和fsync journal；停机锁内迁移。最终新进程下再次逐文件核验两入口SHA、大小、inode/device相同，普通备份拥有独立inode。旧绝对路径通过同卷硬链接保留，冻结候选与原输出引用继续有效；后续重执行使用新布局。

新任务工作、中间产物、临时文件、输出使用 tasks/<logicalTaskId>/{work,tmp,outputs}；Owner和原生节点cwd使用任务根。原始DSH JSONL仍由宿主保存在 D:/dsh_home/sessions，未移动、改写或重建；原基线文件517字节、SHA256 737964d0b28a2d92b7c0e2a9947c93e9eeec1329fb6f2fdd8dbb8d392f05f358保持。

## 验证与恢复证据

- 布局阶段全仓1688项：1686 PASS、0 FAIL、2 SKIP；真实Spring候选另实跑1/1。后续修复按受影响功能定向回归。
- Host顺序证据最新关联184/184 PASS，规划查询反例20/20；原general定义SHA保持1e22a7988d54d9e33883dd46e04c959f8aaea13c66d66b6d73d0fbc8c55dbf92。
- 最终IB消息/账本131/131、服务/清单154/154，0 FAIL、0 SKIP。真实输入独立逐字段逆还原，原输入未变；计入新system后31537/32000，不扩大预算或裁掉事实。
- 部署脚本全部定向组通过，额外缺源/真实封存未launch/Observer明确包名等12断言通过。裸tgz解析旧失效源的失败保留，明确包名原生安装经过隔离复现及正式恢复验证。
- 最终完整备份 D:/dsh_home/backups/owner-repair-20260929-204319-019：20770文件、28表及工件闭包校验通过，包含一致verified-control.sqlite；备份范围是控制库、运行工件、Domain、profile和任务根。原始会话日志保持原目录。
- 正式profile SHA256 5d3e9c333eb33f9a38971e1485f2858ede87e810f7ece49def12c88701fc933f未变。恢复Observer为同内容重新打包，四文件相同，使用持久源；不能把恢复tgz说成原tgz字节相同。

具体实跑证据见 round-5、round-14至round-17；原始私有日志、JSON、下载URL、截图和二进制保留当前任务 docs/tmp，不入库。主检出原有未跟踪文件保持。

## 边界与交付

Windows文件symlink创建报EPERM，该反例保留SKIP；junction与越界反例已实际验证。迁移前六个指定历史原始日志已经缺失，未补造，未声称这些日志已备份；没有重建全部历史工具记录，因此不宣称所有无引用、无标识的散落文件均已找到。旧unknown命令保留，不以批量重放制造通过。话题输入仍有32000字节上限，当前容量实测通过，不承诺无限历史。

PR #142 为 OPEN，本轮未合并、未发布npm版本；本地正式部署与真实专用群验收已有上述独立证据。源码、报告与运行验收分别留证，不以PR状态或HTTP200代替业务完成。
