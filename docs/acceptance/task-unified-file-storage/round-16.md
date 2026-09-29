# Round 16：封存安装续接

本轮解决 r15 原生安装停机后旧 Observer file: 源失效。完整备份沿用 owner-repair-20260929-200540-321，不重复备份、迁移，不伪造 launch.json，不修改任务状态或原始会话目录。

定向 PowerShell 测试：既有全部组 PASS，新增缺源、beforelaunch、原生 pnpm 锁精确替代共 10 断言 PASS。日志 private docs/tmp/task-unified-file-storage/deploy-sealed-final-tests.log。

首次正式零写 Check 通过：writes=0；完整备份 20770 files、28 tables、836 artifactRefs；Assistant 99文件 SHA256 a9fb8acf47121fb4a9efd403fe4d4eb6a987edc52c7a4610ffc1b151e2b37168；Observer 4文件 SHA256 2a47c7af59dde689eb0b0dfff2eaa03a3d60c299584a8b778c2477ec5c344b52。旧史22tasks、76nodes、29runs、68legacy保持。

首次锁内安装仍失败：pnpm在两个裸 tgz 入参下仍解析旧缺源，未生成 launch，保持封存停机。证据 private docs/tmp/task-unified-live-repair-r15/install.log。此为失败，不以 Check 冒充已恢复。

独立迁移复核仍 PASS：18368文件 / 773430821字节，新旧两入口 SHA、inode/device 一致。原基线 JSONL SHA256 737964D0B28A2D92B7C0E2A9947C93E9EEEC1329FB6F2FDD8DBB8D392F05F358；profile SHA256 5d3e9c333eb33f9a38971e1485f2858ede87e810f7ece49def12c88701fc933f，均未变化。

隔离原生 pnpm10.13.1 复现收敛：同一缺源 fixture，裸 recovered.tgz 返回 -4058/ENOENT；显式包名 @zzusp/dingtalk-dsh-observer@file:<同一tgz> 退出0，依赖原生更新为恢复包路径。采用明确包名，不恢复临时旧路径或手改 lock。复现日志 private pnpm-missing-source-reproduction/{bare.log,named.log,result.json}。

显式包名修复后，第二次完整零写 Check 通过；锁内 native plugin add 实跑8.8秒成功，profile依赖原生更新：Assistant使用原r15 tgz，Observer使用 D:/dsh_home/packages/zzusp-dingtalk-dsh-observer-0.5.15-recovered-2a47c7af.tgz。根任务独立 checker package 再次证实99文件与目标包相同。安装后完整备份及旧史重验、启动与真实业务完成尚待记录。

最终恢复通过：原生锁内续接完成，独立Readback ready=true，新PID25164同时监听3080/18998；旧22tasks/76nodes/29runs/68legacy核验通过，Assistant99和Observer4文件相同，认证Web200/token交换303。独立msedge无头看板+详情PASS、pageErrors=0；随后原生Resume并独立 maintenance inactive/revision135，health ok、inboundProcessing=true、真实模型、恢复问题0。两旧任务仍completed/succeeded、executionCount6/7、runSequence3/4、结果相等。群附件新PID下再次下载324字节、SHA相同。新事实消息已mget原文核验，但IB33493/32000容量阻断、没有FACT命令或通知效果，Owner仍未完成；此业务失败转round17处理。
