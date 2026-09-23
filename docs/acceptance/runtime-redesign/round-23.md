# 第23轮：dataset-web 真实工程固定检查

结果：**FAIL（构建阶段预算耗尽）**。本轮不构成部署准入通过，没有真实远端提交或 PR。

## 固定输入与环境

- 业务仓库：HiQ-AI/dataset-web；冻结 commit：1cecf63017a1116439a52e12ef54fb5ac99223b4。
- 原主仓的有效 Git hooks 保留不动；通过独立无模板 source 和真实 managed workspace/freezeCandidate/readCandidate 物化新检查目录。
- DSH Host Node 24；业务检查 Node 22.13.0，Yarn CLI 1.22.22。Vue 子进程路径已独立核对为 Node 22。
- 正式配置一致的固定步骤：install --frozen-lockfile --non-interactive --silent，然后 run build。安装预算600000ms、构建预算900000ms、总预算1200000ms；原始输出上限32768字节。
- 本轮创建全新检查目录，未复用前轮 node_modules 或构建缓存。没有改业务源码，也没有弱化构建。

## 实际回读

| 步骤 | 耗时ms | 退出码 | 结果 |
| --- | ---: | ---: | --- |
| 安装 | 203545 | 0 | PASS |
| 构建 | 900878 | 1 | timeout |
| 总检查 | 1104423 | 1 | FAIL |

本轮输出仅安装1178字节、构建stdout156/stderr1184字节，未触发输出上限。构建末日志为 Babel 处理 cortex-assistant-ui 大包的提示，没有确定性编译错误。CPU采样最终约722秒、工作集2.37GB；进程实际执行了编译计算，不可描述为 Runtime 空等。更早的已安装目录纯 build 以583527ms退出0，完整输出25356字节；该热构建不替代本轮 fresh 检查。

原始结果：docs/tmp/dataset-workflow-check/node22-budget-result.json；SHA256：E8C497D36EC25516543CD409D9DD4072F0E71BC49BEFFFD52CDC845ADBB0A442。CPU样本：同目录 node22-budget-cpu.csv。完整检查脚本：node22-budget.mjs；原始结果与脚本保留本地，不提交临时业务仓库或依赖。

当前结论：冷构建仍未达到固定预算，工程准入未完成；不能通过删日志、放弃build或用热缓存结果覆盖本轮失败。下一步需定位冷/热差异与具体编译阶段，再决定环境准备和构建预算。
