# 本地代码验证

2026-09-28，基于最新 origin/main 48eeaf2 独立 worktree。

`node --test test/task-worktree-archive.test.js`：9/9 PASS，0 FAIL。包含远端推进、原分支删除且提交仍保存、远端改写后拒绝、未推送提交拒绝、脏代码/未知文件、删除目录文档精确恢复、二进制字节、checkOnly 零写、目标冲突与缺 blob 拒绝、已有摘要恢复及路径边界。

`node --test --test-name-pattern='叶子登记的 worktree' test/runtime.test.js`：1/1 PASS，证明跨任务占用与脏代码仍拒绝，正式 Runtime 收口后迁出文档并删除自建目录。

初轮新增重试测试把已 cleaned 条目再次传给仅接受 registered 的清理入口，失败；改为模拟最终状态未落盘的 registered 条目，未放宽正式门禁，最终 9/9。

对两个真实任务 5 个自建目录用当前源码执行 checkOnly，全部通过；其中侧栏目录的 11 份登记文档从准确 Git HEAD 读取。预检不写文档、不更新任务状态、不删除目录。私有 ID、路径清单及运行日志仅存 docs/tmp，未部署结果不得从本轮测试推断。
