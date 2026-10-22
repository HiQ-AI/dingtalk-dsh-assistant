# 单任务阶段边界修复

基线：35cfdf343eef8d275c1d1e98fbf835d44005e582。

实际 task-session 路由、独立协调 planner、Task Owner 共用任务边界说明：同一交付目标的评审、开发、部署 UAT 保留为一个 Task，已有任务补充原目标，完整传递顺序及验收要求。明确不同任务仍保留跨任务依赖。不新增阶段引擎、不按关键词合并任务。

这是模型的语义合同，Host 仍校验结构、版本、回执及门禁，不声称提示词能保证模型绝不误拆。Owner 仍须核验完整目标；程序不能独立理解 UAT 是否已经满足。

## 本次验证

- `coordination-observed-prerequisites.test.js`：新增单一创建 envelope 与原 Task 补充要求的精确断言，顺序数组不被拆分或丢失。
- `coordination-execution-proof.test.js`：新增评审 execution.result/drained、Owner wait 及重开账本后 Task 仍 active、完整要求保留的回归。既有 A→B 正式证明及版本回归继续通过。
- 上述两文件与 `dynamic-task-store.test.js` 首轮 115/115；补第二个测试后前两文件 20/20。组间重叠，不相加。
- `independent-coordination-native.test.js` 新增两项真实 Host + scripted LLM 的入口测试，检查实际路由/planner/Owner 提示注入、新需求只一 Task、已有 Task 不另建、Owner 完整输入及评审结果不结项。
- 默认 profile 缺 `@deepseek-ai/dsh-base`，两份 native 文件共 10 项跳过。已有 `/workspace/coordination-replay-runtime/package.json` 可加载 base，但原生 preset 在 fixture 初始化时报告 `fs-local` / `tool-fs: never started`，10 项失败均在业务场景前；另一个已有 LLM-only profile 也缺 base。没有修改共享 fixture、安装依赖或放宽断言掩盖该阻断。这两项新 native 测试尚未经可用 profile 实跑，不具备已验证原生入口的交付结论。

本次没有真实模型调用、群外发、PR、合并或部署。后续需在兼容原生 profile 补跑上述两个 native 文件；真实语言理解质量仍须另行获授权的模型回放验证。
