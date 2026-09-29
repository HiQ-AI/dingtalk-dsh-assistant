# 任务文件统一收纳

> 状态：ACTIVE
> Goal ID：task-unified-file-storage
> 最近维护：2026-09-29T14:57:01+08:00
> 权威目标：D:/codex/worktrees/task-unified-files/dingtalk-dsh-assistant/docs/acceptance/task-unified-file-storage/goal.md

## 总目标

按已确认的精简方案，将新逻辑任务的工作文件、中间产物、临时文件与交付物收纳至 Agent 工作区 tasks/<logicalTaskId> 的 work/tmp/outputs。DSH 原始会话目录和存储机制保持现状。

## 完成条件

- 普通任务、工程执行、验收及正式文件出口使用统一任务根；重跑同根，节点和执行代次隔离。
- 重启可继续读取新路径工件；旧任务及旧引用原路径可读，无历史数据迁移。
- 定向真实测试、路径越界反例及新旧路径共存测试通过，证据可读回。
- 提交 feature 分支和中文 PR，回读 PR 状态；未合并、未部署与未真实渠道验收分别明确。

## 范围与约束

- 不修改主检出已有文件、运行配置或正式数据。不修改 DSH、数据库 schema、看板或任务业务状态。
- 不增加 task.json、交付索引和新存储平台；复用现有任务关系、工件 descriptor、效果账及受管目录校验。
- 原始日志和公共附件保留宿主存储；已有任务保留原路径恢复。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | 路径与工件归属 | 统一确定性目录；新引用可定位，旧引用可读；越界拒绝 | 完成 | round-1.md；task-file-storage 测试 |
| SG2 | 会话及文件出口接入 | 新任务 cwd、Markdown、文件输出与下载同根；历史恢复不变 | 完成 | round-1.md |
| SG3 | 工程及验证接入 | 源码副本、检查、验收与子进程临时文件同根 | 完成 | round-1.md |
| SG4 | 集成与回归 | 普通/工程/重跑/重启/隔离反例通过 | 完成 | matrix.csv、round-2.md；文件 symlink 为环境限制 |
| SG5 | 文档与 PR | README/runbook 更新，提交与 PR 独立读回 | 进行中 | README 与部署说明已更新；PR 待创建 |

## 当前检查点

- 当前子目标：SG5
- 唯一下一步：提交已验证代码及文档，创建 PR 并独立回读。
- 未闭环项：PR 创建与独立回读。部署、合并及真实渠道验收不属于本轮。

## 进展

- 2026-09-29：读取已确认方案，fetch origin；独立 worktree 基于 45040c7，pnpm install --frozen-lockfile 成功。主检出保持原分支及未跟踪文件。

## 重大决策

- 用户明确原始会话目录不动，取消 DSH 日志路由及迁移改造。
- 工件引用需直接定位任务路径，禁止扫描全部任务猜测摘要归属；避免新索引表。

## 重要信息

- 工作目录 D:/codex/worktrees/task-unified-files/dingtalk-dsh-assistant；分支 worktree-task-unified-files，base origin/main 45040c7。
- 前置方案 docs/spec/task-unified-file-storage.md 为本轮用户确认的精简版。

- 2026-09-29 实施：路径、任务工件、Owner/节点 cwd、Markdown/正式文件、工程检查/验收及备份接入完成。真实新旧任务与重启、Web 重执行、原生日志不迁移验证已通过。
- 保留旧 runner 的源码身份；新任务验收使用独立版本，以维持直接子进程 PID 验证。没有改写 schema 或历史记录。


- 独立审查闭环：workflow 在线换根零写拒绝；备份显式排除受管工程 node_modules，复制不遍历链接，其他链接仍拒绝。
