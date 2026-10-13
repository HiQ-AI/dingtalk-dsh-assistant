# 第 1 轮：定位发行字节漂移

2026-10-13，最新主线 316b491 双包完成安装，原生计划任务启动退出 1；运行日志报 ENGINEERING_DEFINITION_DRIFT，完整启动未通过，未恢复派发。原部署收据保留在本地 docs/tmp/remove-task-sheet-sync-local-20261013-01，包/profile/维护/控制快照未覆盖。

profile 摘要前后一致，仓库配置门禁已经通过；错误发生在唯一需恢复的 succeeded v22 定义。只读探针重建得到 9f80596bf5ec3e75e29452ece8fedce286b7f1f0d4a928590a85f43c4e63f5b1，与持久摘要 9efa68d6ea6e3af247f802a78f9ea302f26b0dae425f358e8486719986e08ee8 不同。只在内存恢复 engineering-output-contract.js 原发行字节后，重建摘要与持久值精确相等。

该文件规范化内容完全相同；旧包 35 CRLF，其余 LF，新 checkout 53 CRLF。变化进入 validateEngineeringApproach.toString()，再进入 task-workflow.js:893 的嵌套 rulesDigest。旧包的其它已受 .gitattributes 保护的冻结 helper 字节不变，配置漂移和真正函数逻辑变化均被排除。

新增回归先在未修复字节运行：node --test test/engineering-approach-contract.test.js → exit 1，6 tests / 2 pass / 4 fail（父测试包含子失败）。原有两个业务测试通过；文件/函数摘要及两种 Git checkout 回归失败。另用独立临时 Git 仓库证实：无属性的原混合字节经 autocrlf=true add 后统一 LF，checkout 后统一 CRLF。

探针只读控制库，禁止 store.command/artifact.put；为保持零写跳过不参与摘要的候选票据缓存预热，只证明冻结定义重建，不能替代真实进程启动。原始日志与诊断脚本仅保留 docs/tmp，不含入库业务数据或凭据。
