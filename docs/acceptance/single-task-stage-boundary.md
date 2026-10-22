# 单任务阶段边界修复

基线：35cfdf343eef8d275c1d1e98fbf835d44005e582。

实际 task-session 路由、独立协调 planner、Task Owner 共用任务边界说明：同一交付目标的评审、开发、部署 UAT 保留为一个 Task，已有任务补充原目标，完整传递顺序及验收要求。明确不同任务仍保留跨任务依赖。不新增阶段引擎、不按关键词合并任务。

上述为非穷举示例。生产共享规则不再列举具体阶段，明确适用于任意领域、阶段名称、数量和用户指定顺序；不得套用模板、惯常流程重排或增加用户未要求的交付阶段。原生用例扩为软件三阶段、稿件翻译校对两阶段、调研四阶段，以及校对后翻译修订的反向顺序，各自覆盖新建与原任务补充，精确断言完整 objective 和 requirements 数组，无额外阶段。

这是模型的语义合同，Host 仍校验结构、版本、回执及门禁，不声称提示词能保证模型绝不误拆。Owner 仍须核验完整目标；程序不能独立理解 UAT 是否已经满足。

## 本次验证

- `coordination-observed-prerequisites.test.js`：新增单一创建 envelope 与原 Task 补充要求的精确断言，顺序数组不被拆分或丢失。
- `coordination-execution-proof.test.js`：新增评审 execution.result/drained、Owner wait 及重开账本后 Task 仍 active、完整要求保留的回归。既有 A→B 正式证明及版本回归继续通过。
- 上述两文件与 `dynamic-task-store.test.js` 首轮 115/115；补第二个测试后前两文件 20/20。组间重叠，不相加。
- `independent-coordination-native.test.js` 新增两项真实 Host + scripted LLM 的入口测试，检查实际路由/planner/Owner 提示注入、新需求只一 Task、已有 Task 不另建、Owner 完整输入及评审结果不结项。
- 初轮选错 profile：默认 resident 缺 `@deepseek-ai/dsh-base`，10 项跳过；旧 replay runtime 的 preset 报 `fs-local/tool-fs: never started`，10 项均在业务场景前失败。仓库已有 `test/fixtures/native-profile/package.json` 专用 profile，37 模块预检通过，无须安装或修改共享环境。
- 在专用 profile 上修正两项测试夹具：断言执行权威成功状态 `succeeded`；已有 Task 先 recover/whenIdle 到稳定等待后再补充，避免初始化竞争；脚本模型中断言移到测试主体，避免断言异常触发模型失败恢复。两项新增 native 实跑 2/2，0 skip。模型由 scripted adapter 提供，原生 Host、Session、账本及工具调用实际运行，不是真实模型理解验证。
- 最终专用 profile 回归：`independent-coordination-native.test.js`、`coordination-observed-native.test.js`、`coordination-workspace-native.test.js` 合计 **11/11，0 fail，0 skip**，包含上述新增两项及真正不同任务 A→B、已完成 A、暂停 B、定时查询与 cwd。没有重复全量或真实模型测试。
- 通用化后的定向复验：`independent-coordination-native.test.js`、`coordination-observed-native.test.js`、`coordination-observed-prerequisites.test.js`、`coordination-execution-proof.test.js` 共 **36/36，0 fail，0 skip**；其中任意阶段新建/补充 8 项原生入口用例全部通过。与此前组重叠，不相加。

本次没有真实模型调用、群外发、PR、合并或部署。真实语言理解质量仍须另行获授权的模型回放验证。
