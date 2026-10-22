# 第7轮：双执行后端实现及首错

本轮对应子目标 SG7，沿原 PR 分支实现可配置 DSH / Claude Code CLI 执行，默认 DSH。统筹与三个执行成员的职责和本轮过程分别保存在 `round-7/coordinator-execution.md`、`cli-execution.md`、`config-execution.md`、`acceptance-execution.md`。文件在本轮持续补充；R1–R6 不覆盖。修复后的冻结验收另记 R8，子目标和执行成员不重建。

## 首错与修复

| 证据 | 发现 | 修复及复验入口 |
| --- | --- | --- |
| `round-7/backend-documents-1.log` | 统一消费文案误改 DSH 模型步骤语义 | 按持久后端分别表达；`backend-documents-2.log` 29 PASS |
| `round-7/backend-service-regression-1.log` | 15 PASS、1 FAIL；既有归档测试只截取多行 Proxy 首行 | 修完整代码边界，生产归档不变；同上含归档 2 PASS |
| `round-7/cli-native-independent-2.log`、`cli-native-ordering-repro.log` | stdout 结果结算慢于 MCP submit，误报 operation_pending | 按实际 tool-use 身份关联通道，前序结果处理完成后准入；最终独立 26 PASS |
| `round-7/cli-native-boundaries-1.log` | 4 项断言通过但测试进程未退出；drain=false 提前抛错跳过关闭 HTTP listener | 先关闭权限桥并等待已准入回调，再判断进程排空；占位保护保留，最终测试自行 exit 0 |
| `round-7/process-range-audit.log` | 探针误设父退出后孙仍存活；本机 Job 已自动清理 | `process-range-audit-2.log` 独立核对；最终取消用例从父/孙均活跃起测 |
| `round-7/backend-release-smoke-1.log` | 13 PASS、1 FAIL；新增测试后 suite-map 过期 | 正式 update/check，不改历史 hash 或跳过守恒；最终完整 smoke 14 PASS |

Store 初次夹具将缺省字段显式写成 undefined，被 canonical JSON 合同拒绝；修为真正省略字段，103 项通过。原命令额外带不存在的 execution-document.test.js 不计文档测试，文档另由实际文件验证。真实 CLI 首次两轮摘要对不存在的 session-id 参数错误取 argv[0]，原始 journal/resume 仍正确；保留首次材料，修脚本后新目录复验，第二轮 sessionId=null、resume=原 UUID。

## 未受首错影响的证据

配置与模型 17 PASS，缺官方 Web registry 的 1 SKIP 由安装 Web profile 实跑 3 PASS 补齐；最终 UI 合同 112 PASS，Observer 独立 71 PASS。真实 Chrome 的草稿/失败/刷新/键盘/390px/后端入口测试通过，UI audit 与 DESIGN lint 均 0 错误、0 警告。真实服务和 SQLite 的混合团队 1 PASS；原生 provider 恢复 9 项、阶段 3 项及 HTTP 回归通过。详见各成员执行文档和日志。

真实 CLI 使用回环合成模型，无真实账号或远程模型推理。用户明确之后登录，本轮不等待登录，也不把这些证据当作部署或真实业务 E2E。
