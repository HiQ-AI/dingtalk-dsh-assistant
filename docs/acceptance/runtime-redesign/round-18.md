# Round 18 — 同进程验证票据复用

## 问题与修复

工程流程 `verify-candidate` 实跑 checks 后，`prepare-commit` 原来再次执行全部 checks。对于包含依赖安装和 build 的检查，这意味着正常流程无理由地执行两轮完整验证。

`task-workflow.js` 现在将本进程 `verifyCandidate` 真正返回的可信票据保留在 factory 私有、有容量上限的 Map 内。缓存键包含 candidateDigest、checks 配置/实现所在 rulesDigest、generation 和 requirementDigest。Host 检查定义在 factory 创建时复制固定。

`prepare-commit` 命中时直接把该内存票据交给原有 `Git.prepareCommit`；后者的 `assertVerifiedCandidate` / WeakSet 和冻结候选物校验保持不变。持久输入里的 `verification` JSON 完全不作为授权票据。新进程或重新构建 factory 没有缓存时，必须重新实跑 checks 得到新票据，失败仍拒绝交付。

## 验证方法

```powershell
node --test test/task-workflow.test.js
```

测试包括：

- 固定分析成功与证据拒绝。
- 真实工作区/结构化修改/冻结检查，以及本地 Git push 和隔离 PR 读回两条流程，均断言正常执行 `checkCalls === 1`。
- 真实独立 Node 进程重建相同 Host factory。输入刻意携带伪造持久 `verification` JSON，新进程实际检查计数由 1 增至 2，返回真实检查日志 `actual check 2`，准备出的 commitId 与第一进程相同。没有执行额外 push 或真实 PR。

本轮不把 WeakSet 票据序列化，不降低 Git 可信验证门禁，不承诺跨重启跳过检查。

## 实跑结果

首次完整执行 4 PASS / 1 FAIL：正常两条工程流程均已确认 checks 只执行一次；新增进程测试误把源仓库配置为 remote，被既有 `GIT_SCOPE_INVALID` 门禁拒绝。仅修改测试 fixture 为独立 bare remote 后：

```powershell
node --test --test-name-pattern='全新Node' test/task-workflow.test.js
```

新增用例 1/1 PASS（16407 ms）。实际新 Node 进程重新运行检查、忽略伪造持久 JSON、检查计数和 commitId 断言均通过。本轮没有把分次结果误报成完整命令一次 5/5；最终完整回归由父任务统一执行。
