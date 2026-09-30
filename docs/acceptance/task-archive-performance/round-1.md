# 第一轮验证

日期：2026-09-30；基线：origin/main 50cfb89；Windows 11 / PowerShell 7。

## 性能

复现命令（仓库根运行）：

```powershell
New-Item -ItemType Directory -Force docs/tmp/archive-performance | Out-Null
git show 50cfb89:packages/dingtalk-dsh-assistant/task-worktree-archive.js | Set-Content -Encoding utf8 docs/tmp/archive-performance/baseline.js
node docs/acceptance/task-archive-performance/scripts/benchmark.mjs docs/tmp/archive-performance/baseline.js
```

脚本新建一次性本地 bare 远端，每轮新建已推送目录及一份未跟踪登记文档，交错前后顺序，计时只覆盖归档（基线包含 Runtime 的单目录额外 checkOnly）。不是 HTTP 完整响应测量。每次独立确认迁出文档字节、目录消失和 Git 登记移除。

首次与测试并行运行：基线 3677/4215/4442 ms，优化 2055/1881/2286 ms；中位数 4215 → 2055 ms（51%）。排除并行测试负载后复测：基线 3809/3931/3783 ms，优化 2128/2108/1903 ms；中位数 **3809 → 2108 ms，减少 45%**。最终报告采用后一组。

## 安全与入口

- `node --test test/task-worktree-archive.test.js`：13 pass、0 fail；覆盖脏代码、未知文件、未推送、主检出/越界、后代提交、历史改写、换分支、复制期间推进 HEAD、远端推进/删除/改写、缺失目录恢复、目标冲突及状态写入失败重试。
- `node --test --test-name-pattern='叶子登记的 worktree' test/runtime.test.js`：1 pass、0 fail；包括跨任务占用拒绝、第二目录脏代码时首目录和文档保留，以及恢复单目录后成功清理并回读归档元数据。
- `git diff --check`：退出码 0。

正式实例尚未部署；真实网络、文件量、全看板刷新及新版 workflow 归档耗时未验证。
