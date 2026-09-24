# 工程任务直接检索流程（第 33 轮）

日期：2026-09-24。

## 改动与范围

- 新发起且配置目录发现的工程任务使用 v6：`prepare-generation → prepare-workspace → inspect-and-propose → apply-changes → verify-candidate → 交付节点`。模型通过受管只读工具按需列路径、搜索正文、分段读取；写入仍由 Host 校验目录白名单和文件哈希。固定文件清单任务保留原定义。
- 旧 v5 任务只在失败节点已排空、没有编辑/交付效果且控制账无待接纳输入时，将同一运行重编排到新代次；历史节点保留。领取次数保留有限上限，新代次一次性补足节点所需领取次数。
- `EDIT_PREPARED_INVALID` 与 `ENGINEERING_EDIT_SCOPE_MISMATCH` 等确定性等待不再被后台恢复扫描自动反复领取。

## 定向验证

- `node --test --test-name-pattern='新工程流程直接按需读取|旧工程失败节点仅在排空' test/task-discovery.test.js`：2/2 通过。
- `node --test --test-name-pattern='按需检索支持路径缩小范围' test/task-discovery.test.js`：1/1 通过，覆盖 4000 字符读取、路径缩小范围、越权拒绝。
- `node --test --test-name-pattern='工程只读工具在原生节点会话中可用' test/execution-session-native.test.js`：1/1 通过。
- `node --test --test-name-pattern='Web事件已准备后中断由恢复通路接纳一次' test/workflow-service.test.js`：1/1 通过。
- 本轮没有运行全量测试，遵循用户要求。

## 本地回读与发现

- v9 存储只读预检：`ok=true`、`invalidRecords=0`、`strippedFields=0`。
- Assistant 本地包 `0.5.15-local.20260924.10` 的 64 个 JS/YML 文件、Observer 本地包 `0.5.15-local.20260924.2` 的 3 个 JS/YML 文件均与源码逐一哈希一致；本地 `/health=ok`，DWS inbound ready，`recoveryIssueCount=0`。
- 归一化任务 `run-af34f1d5c616a1227a35fc3de58e70ad007143c2` 已在同一运行迁移为 generation 2、12 个当前节点，浏览器显示原旧索引/选文件节点不再是当前流程。原生会话真实调用 `engineering_repo_inspect` 检索和读取文件。
- 该任务绑定的唯一准入仓库是 `dataset-web`。会话检索前端源码后提交 `{"changes":[]}`，写入节点停在 `ENGINEERING_EDIT_SCOPE_MISMATCH`，没有新编辑效果；这说明流程已运行，但业务修复尚未完成。当前局部配置没有后端 `dataset` 仓库，不得把空修改当作修复完成或继续自动消耗领取次数。
- 草稿任务 `run-d2aa74700cc586d8c60f840d12e1a61fec590efd` 在旧版外部验证时被部署切换打断；已独立确认原构建进程树退出和效果账无未决项，以受管 `node.drained` 命令登记证据。再次验证的构建进程退出后节点未收尾；第二次切换前核对没有外部子进程与未决效果，停机执行 `--check` 与受管排空登记，重启后同一节点由 lease 2 恢复到 lease 3、领取数 74→75，未重复编辑效果。该任务最终构建与交付结果仍需由自身流程回读，不能以本轮构建产物时间戳判定通过。
- 内置浏览器任务详情页实际显示 `准备任务代际 → 准备工作目录 → 梳理修改方案 → 应用修改`，节点 3 已完成且有会话记录；不再展示四个旧发现节点。此轮任务在应用修改节点等待 `ENGINEERING_EDIT_SCOPE_MISMATCH`，未冒充业务完成。

## 未完成边界

- 归一化业务修复需先准入正确仓库并按受控任务变更处理；此轮没有通过修改配置或新建任务绕过既有 Task 绑定。
