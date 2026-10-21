# 三类优化验收

2026-10-21：三类改动已实施，matrix.csv 每项最新轮次均 PASS。本机插件已切换修复包，公共脚本与三个现有 skill 已在实际运行路径生效；没有新增宽泛 skill。

代码交付：[PR #227](https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/227)，状态 OPEN，main ← worktree-task-resource-lease；核心提交 `f87371eec5094e90dee9ceae277998dfc990ec3d`。已独立回读 PR 正文与本地文件一致，当前无远程检查记录。个人公共脚本/skill 修改位于实际运行目录，PR 包含其验证材料；本地安装已完成，不表示 PR 已合并或 npm 已发布。

1. 插件：整段执行原子取得声明资源，同资源等待、异资源并行。续办保留资源，结果提交不提前释放；后台作业、unknown 和重启保持占用，安全排空后自动恢复等待者。实时查询直接展示状态与阻塞者，每次资源状态查询只读一次锁表。
2. 公共健康脚本与运行指引：`D:/baibu-agent/scripts/read-uat-health.ps1` 成功显式返回 0、失败返回 1；保留 JSON，调用后立即捕获退出码，并独立检查 healthy。`docs/ops/woodpecker-uat.md` 与部署 skill 使用同一合同。
3. 现有 skill：`D:/dsh_home/skills/` 下 business-development、uat-pr、uat-deployment 补齐固定验证候选、目标权限夹具、实际持锁观察与查询作用域、UNKNOWN 有界预检、健康及运行版本证据边界。新增的是 uat-pr 的只读 helper，未新增 skill。

| 验证层 | 结果 |
|---|---|
| 最终候选账本/资源/观测 | 112 PASS，含 17 项资源回归 |
| 最终候选定向原生会话 | 9 PASS |
| 真实打包、解包任务与启动 | 2 PASS；前轮一次超时已独立复验通过 |
| 已安装模块隔离资源回归 | 17 PASS |
| 公共健康脚本真实 loopback HTTP | 31 PASS |
| 合并预检只读 helper | 23 PASS，另有真实 GitHub GET 核验 |
| skill 结构/本地引用/独立场景 | 3/3、14/14、六场景明确决策；纸面演练不冒充模型 E2E |
| 当前本机运行 | 新 PID 双端口，health=ok，恢复异常 0，入站/DWS 就绪，匿名 Web=401 |

失败基线与反证保留在 round-1 至 round-5、independent-review.md。安装包、模块 hash 和独立现场回读见 round-6.md。最终测试均无跳过；测试/包/进程/HTTP/业务各自分层，不以其中一层替代其他层。

互斥仅保护同一控制库内已声明资源，不阻止其他实例或外部人为发布。未发布 npm，未触发 Dataset/UAT 发布，未发送真实钉钉验收消息；后续实际任务仍须按既有发布和业务验收证据收口。
