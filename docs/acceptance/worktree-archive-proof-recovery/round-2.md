# 登记之后继续开发的提交核验

2026-09-28，基于 origin/main 9c94573 的独立 worktree。

真实症状：合并来源参考产品单位快照任务的当前 HEAD 是登记 HEAD 的后代，当前工作目录干净，实时 origin 同分支头与当前 HEAD 完全一致，但旧 sameIdentity 要求 HEAD 不变而拒绝。

调整后，目录、主库、Git目录、分支和 origin 仍严格一致；登记后代且实际 HEAD 已保存远端才允许。迁出文档进度保存实际核验 HEAD，二次准备后的 HEAD 必须等于首次快照，复制期间有新提交仍拒绝。

- `node --test test/task-worktree-archive.test.js`：13/13、0失败；新增已发布后代成功与未发布拒绝、同分支历史改写拒绝、换分支拒绝，以及文档复制期间 HEAD 推进且已推送仍拒绝删除，之前恢复、路径和冲突门禁全部回归通过。
- `node --test --test-name-pattern='叶子登记的 worktree' test/runtime.test.js`：1/1、0失败，原跨任务占用、脏代码及文档清理路径有效。
- 实际任务两个自建目录 checkOnly：通过，文档6份；不更新任务、迁出文件或删除目录。
- `git diff --check`：无错误。

本轮代码及预检不等于正式部署或真实归档。私有任务记录、路径清单和日志留 docs/tmp，交付后独立回读正式归档状态、6份文档摘要与目录状态。
