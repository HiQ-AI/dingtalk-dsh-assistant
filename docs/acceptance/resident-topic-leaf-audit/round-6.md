# Round 6：Topic 归属与读取预算修复

## 基线

- 分支：`worktree-topic-routing-hardening`
- 基线：`main@94cbfdf4afc0d680ce1a460f805606b3d8e1eff6`
- 真实案例：群消息 #886 被错误关联到旧缺陷 Topic；只读取既有运行态和 Session 记录，不重放消息。

## 修复前证据

| 用例 | 结果 | 观察 |
| --- | --- | --- |
| R6 | FAIL | #886 为恢复分支与 PR 资料而关联旧缺陷 Topic，旧摘要随后写入分支信息。 |
| R7 | FAIL | 多 Topic 消息的动作主归属按 Topic 创建顺序选择，忽略路由提交顺序。 |
| R8 | FAIL | 决策内联为 36,641 字符时，默认 Topic 读取仍一次返回 122,454 字符。 |
| R9 | FAIL | 新建与恢复叶子均使用 `workspace-write`，未开放完整本机能力。 |

## 修复后证据

| 用例 | 结果 | 观察 |
| --- | --- | --- |
| R6 | PASS | 归类协议把资料查询与 Topic 归属分开；多 Topic 缺少逐项关系或理由时，Schema 与 Store 双层拒绝。 |
| R7 | PASS | 路由显式指定 `effectOwner` 并持久化到 Topic entry；隔离用例把后创建的 Topic B 设为 owner，结果不受创建顺序影响。 |
| R8 | PASS | Topic 工具完整 JSON 每次不超过 40,000 字符；90,000 字符单消息按连续片段读取，跳读不能解锁决策。 |
| R9 | PASS | 新建和恢复叶子均应用 `danger-full-access`；静态断言禁止遗留 `workspace-write`，Resident 保持 `read-only`。 |

## 回归

- `pnpm test`：250/250 PASS。
- `node --test docs/acceptance/resident-topic-leaf-audit/scripts/probe.mjs`：A01–A10 10/10 PASS。
- `node scripts/build-web-client.mjs` 后 `git diff --exit-code -- packages/dingtalk-dsh-assistant/web-client.js`：PASS，无意外前端产物差异。
- 根包、assistant 包与 observer 包执行 `pnpm pack`：3/3 成功。
- `git diff --check`：PASS。

本轮不重放或修改 #886/#891 的历史真实归属记录；代码修复约束后续路由，历史数据修订需独立的数据操作与回读。

## 合并与本地部署

- PR #75：`MERGED`，head `5986bdcc3c8c6d826c36d6b392aa8788ddaed889`，merge commit `29b73e268b8932832165747f4f5b50b307f64c93`。
- 本地主仓 `main` 与 `origin/main` 均为 `29b73e268b8932832165747f4f5b50b307f64c93`。
- Web profile 指向 `29b73e2` 独立产物目录；安装后 `runtime.js`、`topic-runtime.js` 与 main 源码 SHA256 分别一致。
- 新进程 `GET /health` 返回 `status=ok`、`transport=dws`、`recoveryIssueCount=0`；群监听和本人私聊监听均为 `ready`，backfill 为 `ok`。
- 未认证访问 Web 返回 HTTP 401；独立受控 Chrome 成功加载已认证的“钉钉群聊运行看板”，页面显示“运行正常”及群聊、话题、任务、人工介入、归档、告警入口。
