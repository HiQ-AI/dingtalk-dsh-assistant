# 当前开发与执行重跑

当前 v20 开发流程为技术方案（document、scopePaths、criteria，不含 before/after）→ apply-changes Agent 读取当前源码实施。没有独立 validate-proposal。后续保留真实检查、业务 UI 验收、commit、push 和 draft PR，绝不自动 merge/deploy。

POST /tasks/:id/reset-execution 是本机 Task 管理入口。请求字段为 requestId、expectedControlRevision、reason、checkOnly、prepareNewRun。preview 只读；执行必须处于维护状态、已排空且该任务 paused。旧 run 从当前执行视图归档，需求、验收、代码工作区、原群来源和全部外部效果回执保留，不物理删除文件。重复 requestId 只返回同一次结果，变更内容拒绝；不同重复点击使用旧控制版本拒绝。已存在成功 commit/push/PR 时，不创建自动重复交付链。

prepareNewRun=false 让任务保持 paused/pending；true 使用当前 v20 在同一个 Task 下预建一个暂停的新 run，并复用已登记的源码工作区和原开发分支，不覆盖脏文件。只有显式选定 run 的维护作用域及任务 resume 才启动。新流程不新增逐节点用户授权；外部操作保留任务、仓库、分支、实际验收及去重边界。
