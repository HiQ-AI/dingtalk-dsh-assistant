# 第 34 轮：工程仓库纠偏与同任务重发

## 现场原因

- 归一化任务 `task-af34f1d5c616a1227a35fc3de58e70ad` 原运行 generation 2 绑定 `dataset-web`，`inspect-and-propose` 产出空 `changes`，`apply-changes` 等待 `ENGINEERING_EDIT_SCOPE_MISMATCH`。
- 独立 `dataset` 源检出 `origin/main` 为 `bb022f5279483e8b8814d6486ccf82d63ef3f1ec`，包含后端合并实现；原前端仓库无法完成该目标。
- 控制库只读回查：所有当前节点 `drained=1`，效果账只有 `prepare-workspace` 成功，无编辑、提交、推送或 PR 效果，pending 输入为 0。

## 插件修复

- 仓库目录加入用途和路由关键词，唯一命中另一仓库时拒绝错选；用途元数据不影响历史执行配置摘要。
- v7 空方案给出 `ENGINEERING_NO_CHANGES_PROPOSED`，历史 v6 保持原定义；v7 只读仓库工具已开放并通过真实受管工作目录用例。
- 本机同源 Web 重发入口校验操作者、严格参数和当前任务效果账；Store 在同一运行中递增代次、保留历史节点，并从准备节点重新领取。

## 验证与部署

- 定向 `node --test --test-name-pattern='工程空方案重发保留原任务|空方案工程任务仅在排空|工程registry按Task冻结配置|工程仓库重发仅接受本机' test/workflow-engineering.test.js test/task-discovery.test.js test/http.test.js`：4/4 通过。
- `node --test --test-name-pattern='新Task真实HTTP补充与取消同库幂等' test/workflow-service.test.js`：1/1 通过。`git diff --check` 通过；没有运行全量测试。
- 本机安装 Assistant `0.5.15-local.20260924.11`；已安装的关键源码文件 SHA256 与工作区逐项一致。`/health` 为 `ok`，恢复问题数为 0，工作流目录列出 `dataset-web`、`dataset`。
- 插件接收 `reissue-normalization-dataset-20260924-1` 后独立回读：原 taskId/runId 保持，代次由 2 到 3；`prepare-generation`、`prepare-workspace` 已完成，`inspect-and-propose` 已运行；其叶子会话对后端 `DatasetMergeCommonServiceImpl.java` 的分段读取返回成功。
- generation 3 的叶子在读取约 53 KiB 的后端文件后仍提交 `changes: []`，`apply-changes` 明确等待 `ENGINEERING_NO_CHANGES_PROPOSED`。没有编辑效果。针对完整文件输出过大的缺口，v8 增加 `replacements` 精确替换合同及 Host 还原；局部测试扩展为 5/5，覆盖短片段成功、未命中拒绝、空方案、同仓库单次流程升级、越权入口。Assistant `0.5.15-local.20260924.12` 的关键源码哈希与工作区一致，`/health=ok`、恢复问题数 0。
- 插件接收 `reissue-normalization-patch-v8-20260924-1` 后独立回读：仍是原 taskId/runId，代次由 3 到 4；后续业务节点结果待回读。

## 边界

本轮仅修复、部署插件并通过插件重发原任务。业务代码修改、固定 Maven 检查、Git 交付与完成通知仍须由插件任务后续节点自行完成，并分别回读；本轮没有直接编辑 `dataset` 业务代码，也没有声称该业务任务完成。按用户本轮要求，没有创建部署备份。
