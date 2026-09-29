# 第二轮：集成与回归证据

日期：2026-09-29。Windows 11 / PowerShell 7，Node 24+，独立 worktree；无正式数据写入、部署或钉钉发送。

## 定向回归

1. `node --test --test-concurrency=4 test/execution-artifacts.test.js test/execution-controller.test.js test/execution-delivery.test.js test/agent-query-tools.test.js test/task-owner-store.test.js test/task-owner-delivery-manifest.test.js test/task-owner-recovery.test.js test/task-artifact-files.test.js test/task-general-workflow.test.js test/task-artifact-write.test.js test/task-group-file-delivery.test.js test/task-group-file-runtime.test.js test/task-file-storage.test.js test/deployment-integrity.test.js`
   - 174 项：173 PASS，0 FAIL，1 SKIP，约 25 秒。唯一跳过为当前 Windows 进程无法创建文件 symlink（EPERM）；真实目录 junction 和最终路径 junction 已测试拒绝。
   - 证明新旧任务读写共存、重启、文件出口与效果账、坏摘要拒绝及越界反例；渠道工具为测试适配器，不代表真实钉钉发送。
2. `node --test test/workflow-service.test.js`
   - 149/149 PASS，约 253 秒。真实 Web 重执行：原任务、第一次与第二次重执行的 family 根一致，输入/输出/证据/补充要求直接读盘一致，工程冻结的 taskFiles 也指向原根。
3. `node --test test/task-owner-store.test.js test/execution-runtime-native.test.js test/session-workspaces.test.js`
   - 26/26 PASS。完成清单接纳限定引用、非法摘要仍拒绝；原生跨进程恢复保持既有协议。
4. `node --test --test-name-pattern='工作区|workflow 启用' test/runtime.test.js`
   - 7/7 PASS。workflow 在线换根零写拒绝，同根/模型修改可用；旧 Resident 切换屏障仍通过。
5. node_modules 备份修复后独立重跑 `node --test test/deployment-integrity.test.js`：19/19 PASS。
   - 真实 junction 依赖及嵌套 node_modules 在复制前裁剪，复制和回读通过；outputs 下同名链接仍拒绝。manifest 显式记录排除规则。
6. `pwsh -NoProfile -File test/deploy-owner-repair.test.ps1`：13 组、52 断言通过，包含 TaskDirectory 传递与缺失阻断。

## 工程及原生会话补充

- 原生执行与 Owner 两文件：42/42 PASS，日志位置与恢复 cwd 独立读回（第一轮记录）。
- `node --test test/workflow-engineering.test.js test/execution-local-acceptance.test.js test/local-acceptance-project.test.js test/local-acceptance-readonly.test.js test/local-acceptance-review.test.js test/local-acceptance-merge.test.js`：86/86 PASS；`test/execution-pr.test.js`：9/9 PASS（首次集成）。
- 路径安全修复后，验收定向 2/2、检查/取消定向 3/3、工程路径定向 1/1 PASS；工程与只读验收组合另一次 36/36 PASS。覆盖祖先 junction 零外写、tmp/evidence 拒绝时无执行预约以及整棵子进程取消。
- 旧 `execution-local-acceptance.js` 与 `execution-check-job.js` 无 diff。新专用 runner 复用公开的进程归属函数；其余闭包无法提取而不改变旧源码摘要，保留独立实现以维持直接 PID 验证。

## 边界

最终源码身份归一化后补跑：`node --test --test-concurrency=2 --test-name-pattern='正式 Web 重执行|任务目录验收|新任务验收runner|任务验收拒绝|任务检查' test/workflow-service.test.js test/execution-local-acceptance.test.js test/execution-pr.test.js`，6/6 PASS，约 31 秒。实际服务 PID、tmp/evidence 路径、junction 拒绝与真实 Web 重执行再次通过；LF/CRLF 版本身份一致，真实源码变化仍改变身份。

未运行全仓测试、正式实例安装、真实模型业务验收或钉钉文件交付。文件 symlink 因环境权限跳过，不写成已验证。目录收纳覆盖受管写入入口，外部程序显式绝对路径与公共缓存不自动重定向。备份排除依赖后必须按锁文件重装；不支持在线换根或自动历史迁移。
