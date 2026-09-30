# 第 23 轮：材料到任务执行完整链路

## 范围与证据边界

本轮合并验证工作簿读取、文件消息材料解析、R/IB/最终派发材料继承，以及多条消息恢复公平性。保持来源版本、事项影响、审批和生产执行条件。隔离测试通过不代替真实模型、Task 或通知送达。

## 原始材料只读验证

实际 DWS 下载并经本轮读取器解析两份原工作簿，两份均完整返回 4 个工作表。生产状态工作簿首表覆盖 70 行、25 列，Y 列有 70 个非空单元格（包含表头）；原条目工作簿首表覆盖 70 行、12 列。公式未重算，保留文件内缓存结果。原文件摘要、投影摘要与逐表统计留本机 docs/tmp/message-processing-deploy/workbook-read-summary.json；工作簿正文不进入公开仓库。

## 待完成

组合测试、精确包部署，以及原消息恢复后的任务、材料、阶段条件与渠道回读。

## 部署前验证

- `node --test --test-concurrency=2 test/workflow-service.test.js test/message-workflow.test.js test/message-repair-coordination.test.js`：259/259 PASS，0 fail、0 skipped。
- ledger、impact、context-repair、notification obligations、HTTP 五文件：136/136 PASS；xlsx/DWS 两文件：33/33 PASS。工作流、组合与上下文三文件最终定向：102/102 PASS。
- 第一次服务集成200/201通过；唯一失败为旧材料重试fixture缺少新的来源回读合同，补齐同群/同消息/同附件回读后11项定向及上述最终集成通过，生产来源校验未放宽。
- `pnpm install --frozen-lockfile` 通过。Assistant包99文件与冻结源码一致，SHA256见round-23-packages.json；沿用Observer已验证包。
- 正式部署零写预检通过：writes=0，原22个Task，要求空间约3.04GB，完整备份约1.96GB。维护revision169已排空，开始封存备份安装。
