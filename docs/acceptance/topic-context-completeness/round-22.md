# 第 22 轮：本地验收编排验收与部署

日期：2026-09-26。用户授权：验收并部署。

## 验收范围

验证工程 v11 的本地服务生命周期、实际结果比较、清理与恢复、提交前门禁、节点产出和历史流程读取，再将 Assistant/Observer 精确包安装到本机 web profile。真实 UAT 业务场景尚未配置，本轮不会将隔离用例视为 Dataset 业务问题已验收。

## 验收发现与修复

1. 仓库重发的存储事务硬编码旧节点前缀，v11 的验收条件和计划节点使其拒绝合法重发。按已登记定义版本核对对应前缀，旧版本规则保持。
2. Runner 的恢复查询会为不存在的执行身份创建空目录。恢复改为仅校验目录，创建目录仅发生在准备阶段；增加不存在身份的无写入反例。
3. 更新旧测试夹具的节点绑定命令身份和本地服务配置；双轮真实进程验收增加运行预算，并增加等待状态诊断，保留全部成功与失败断言。

## 已完成验证

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 工作流服务及节点产出 | 90 项通过 | workflow-service.log |
| 控制器、外部效果、HTTP、Owner | 44 项通过 | control-tests.log |
| 消息流程与控制存储 | 74 项通过 | store-message-tests.log |
| 历史任务流程及 v10 验收 | 10 项通过 | message-workflow-tests.log |
| Windows 本地验收 Runner | 6 项通过，0 跳过 | runner-tests.log |
| 工程发现、仓库重发、双轮验收交付及 UAT 合并门禁 | 20 项通过 | engineering-final.log |
| v11 缺配置、失败/候选门禁与共享数据锁 | 3 项通过 | engineering-v11-gates.log |
| 隔离浏览器 | 43 项通过，页面错误及写请求均为 0 | browser/browser-results.json |
| 当前历史产物只读投影 | 73 任务、37 节点、20 类产出通过 | outputs-before.json |
| 当前存储预检 | ok=true，invalidRecords=0，strippedFields=0 | 本轮命令回读 |

本轮原始日志位于 `docs/tmp/local-acceptance-deploy-20260926/`，不提交含运行材料的大文件。复现命令为对应测试文件的 `node --test`；浏览器使用同目录既有 `scripts/verify-observer-browser.mjs` 与独立 headless Edge。

## 部署检查点

共 247 项定向测试通过；浏览器另有 43 项通过。双轮工程用例使用临时仓库、真实回环服务与 Git 操作、模拟 GitHub 适配器，没有对真实 GitHub 创建 PR。矩阵 C30 对应本地验收编排，C31 为真实共享 UAT 业务验收（NOT_RUN），C32 为本地部署。

部署前实例 PID 29244，监听 3080/18998，73 个任务均已完成，health=ok、recoveryIssueCount=0。

- 稳定停机备份：`D:/dsh_home/backups/local-acceptance-20260926-1834`，728 文件、478827968 字节；保存逐文件 SHA256 清单，主控制库、Domain 和配置独立回读一致。
- 原生 CLI 安装本轮唯一目录内 Assistant/Observer 两个 `0.5.15` 本地包，退出码 0；未发布新正式版本。
- Assistant tgz SHA256：`343D1D96A8DE49D7541842CA7CB6D4B6E83BB2BAC2BE9C37DB144BDBE285E808`。
- Observer tgz SHA256：`0F904B63E2C47D1A0EC675689646DC7C1CC009C2AFE0E9E621054BAA48F04A4E`。
- 84 个 JS/YML 文件与安装目录 SHA256 一致，两个 manifest 内容一致，原 profile patch 未改变。
- 新进程 PID 17092 同时监听 3080/18998；health=ok、recoveryIssueCount=0、inboundProcessing=true；认证 Web HTTP 200。
- 73 个任务的身份和状态与部署前一致；37 个历史节点、20 类产出在线分页及文档回读通过，5 个工作流任务保留 executionTiming。

新编排已部署；真实 Dataset 场景及数据清理命令仍未配置，因此相关新工程任务在缺配置门禁等待。本轮没有重放历史任务、发送钉钉消息、修改 PR #371 或将启动检查标成业务验收。
