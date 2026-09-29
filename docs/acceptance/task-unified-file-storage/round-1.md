# 第一轮：实现与反例定位

日期：2026-09-29。基线 origin/main 45040c7，独立 worktree。未部署。

首次接入完成路径、工件作用域、Owner/节点 cwd、文件出口和工程目录后，真实测试得到以下证据：

- `test/task-file-storage.test.js`：真实 SQLite/controller 新旧布局共存、相同内容跨任务隔离、关闭后重开读回、缺文件不回退共享目录、Markdown 和正式文件落点通过。文件 symlink 创建因 Windows EPERM 未执行；目录及最终路径 junction 反例实际通过。
- `test/execution-session-native.test.js test/task-owner-session-native.test.js`：42/42，通过原生宿主读取 JSONL 确认日志仍在宿主根。关闭整个 Context 再恢复时不重新选择 cwd；不同任务、同任务不同节点草稿隔离。
- 工程、验收 runner 及四类验收脚本最初组合 86/86，检查器 9/9；实际子进程 TEMP/TMP/TMPDIR、证据位置和取消进程树验证通过。

反例及修复进入第二轮：

1. 新布局 Web 重执行测试首轮失败：节点已成功，但 Owner 清单入口只接受旧裸摘要引用，任务无法完成。`task-owner-store.js` 改为复用新旧引用解析，保持原完成准入；随后 Web 重执行定向通过。
2. 工程目录及 tmp 创建顺序可能在检查前穿过 junction。改为逐层检查祖先后创建；新增反例证明外部零新增，验收拒绝时也不留下执行预约。
3. 独立审查发现工作区在线切换可让会话与工件分根。runtime 在 workflow 启用时拒绝在线换根，原配置不写入；保留同根及模型更新。
4. 独立审查发现将工程目录纳入备份后，pnpm 依赖链接会阻断部署。明确排除受管源码副本的可再生 node_modules，并让盘点、复制、校验和清单使用同一规则；其他链接继续拒绝。

本轮不将局部通过解释为整体闭环；最终结果见 round-2.md 和 matrix.csv。
