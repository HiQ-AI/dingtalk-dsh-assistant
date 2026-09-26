# Round 18：节点交付物契约与合理性

## 逐节点结论

本轮核对实际执行器和当前 37 个工件、20 类节点（73 个任务），不是仅检查文字非空。节点职责及合理产物矩阵见 `docs/spec/engineering-node-deliverable-contract.md`。

- 确认项目与修改起点：原“准备任务代际”核对既定项目、远端分支、上一轮提交和 PR，并不负责推断项目；新产物记录项目与修改起点。
- 创建独立工作目录：原执行成功后返回输入，丢掉真实目录回执。新产物保存目录与源仓库；当前实现为 git init/fetch/checkout，不是 git worktree。旧记录严格按同一节点和 generation 查询成功效果回执。
- 编写修改方案：实际旧任务只有 replacements 补丁，缺少理由和验证计划。新节点持久化 `修改方案.md` 文档工件及补丁；下载由工件内容生成，不声称源代码目录存在该文件。旧任务仅提供 `修改记录.md`，明确缺失原方案说明。
- 检查修改方案：新确定性节点检查非空、长度限制及全部变更文件路径覆盖；未通过不能进入应用修改。此门禁不证明方案逻辑正确。
- 索引、选择、读取与应用文件：文件数量来自完整工件，默认摘要、按需展开；应用修改回执为实际修改路径与一致性结果。
- 构建与检查：实际 dataset-package 为 Maven `-DskipTests package`，显示“Java 项目打包（跳过测试）”，保存并提供构建检查报告；不能据此声称测试或业务通过。旧纯文本检查没有动作记录时明确范围未知。
- 提交/推送/PR：准备节点提供执行计划或 PR 草稿文档；执行节点显示持久回执；最终节点核对交付地址与状态，不冒称合并或部署。
- 分析/审查链：材料、结论、发现、局限继续来自实际工件；校验节点原样传递已校验结果，不捏造单独报告。可选发布/数据流程没有当前业务样本，未声称在线覆盖。

## 源码与隔离实跑

- 新工程定义 v9，旧登记定义按原版本恢复。独立对比旧提交与新源码生成的 v8 定义摘要完全一致，见 `round-18/definition-check.json`；没有 schema 迁移、业务重跑或通知发送。
- 工程集首次运行遇到本地 schema 子集不支持 minLength/maxLength，改由校验节点执行；旧测试证明接口缺 registry，以及节点插入后硬编码索引/缺文档夹具导致失败，均修正后实跑。日志保留在 docs/tmp/deliverable-workflow-tests.log。
- 工程三文件重跑 20 PASS；包含隔离仓库真正提交、推送至本地 remote、fake gh 和第二轮继续修改。新增契约反例 2 PASS，覆盖空文档、超长文档、缺变更路径、目录回执及跳过测试报告。
- HTTP/Observer/Service 组合重跑 109 PASS，覆盖 Markdown 下载、引用边界、分页和产出语义。
- 浏览器 41 项 PASS、28 次隔离 API 请求、0 写入/页面错误；真实触发下载并读回 Markdown 内容。200 文件折叠、键盘展开、分页、窄屏和耗时位置保留。桌面及 390px 截图已查看；strict 审计 0 findings。PNG 不入库，用 scripts/verify-observer-browser.mjs 再生成。浏览器采用隔离夹具，不是线上业务页面截图。
- 当前工件内容哈希与纯投影审计通过，见 `round-18/projection-audit.json`。在线安装与全量回读结果后续记录。

## 验证命令

```powershell
node --test test/task-workflow.test.js test/workflow-engineering.test.js test/task-discovery.test.js test/http.test.js test/observer-client.test.js test/workflow-service.test.js
node docs/acceptance/topic-context-completeness/scripts/verify-observer-browser.mjs C:/Users/64554/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules docs/acceptance/topic-context-completeness/round-18
node docs/acceptance/topic-context-completeness/scripts/audit-task-node-outputs.mjs http://127.0.0.1:18998 D:/dsh_home/workflows/runtime-v2/artifacts docs/acceptance/topic-context-completeness/round-18/live-audit.json live D:/dsh_home/workflows/runtime-v2/control.sqlite
```

最终六文件组合重跑：131 PASS、0 FAIL、0 skipped（82 秒），含文档跨群、跨任务和错误引用拒绝反例。日志 docs/tmp/deliverable-final-tests.log。
