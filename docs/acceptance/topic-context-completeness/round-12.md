# 第十二轮：任务详情视觉重设计

## 改动

- 顶部中文状态、24px 标题、更新时间、真实步骤完成数与分段进度。
- 左侧阶段与编号时间线，保留 01/02 等顺序号；当前、等待、失败与完成分层显示。
- 右侧突出待处理原因、最新产出和任务目标；窄屏单栏。隐藏技术编号，不增加诊断接口请求。
- 历史执行展开时才加载，保留分页、重试和已绑定会话入口。

## 本轮证据

- `node --test test/observer-client.test.js`：10 PASS，0 FAIL。
- 浏览器脚本：24 项检查通过，17 次只读请求、0 写入、0 页面错误；实际核对 4 个步骤编号与宽窄屏截图。
- `node scripts/build-web-client.mjs` 已执行；Observer 为直接加载 JS，`node --check` 通过。
- Premium strict 静态审计 0 findings。截图为完整 observer 与真实 React 的隔离夹具，宿主 primitives 为语义替身，不代表真实钉钉业务结果。
- C21 任务详情阅读层次与编号保留：PASS；C22 历史按需加载与窄屏：PASS。用户对最终视觉效果尚未反馈，不声称用户验收通过。

## 重现

运行 `scripts/verify-observer-browser.mjs <playwright模块目录> docs/acceptance/topic-context-completeness/round-12`。截图本地生成，不入库。

## 本地更新回读

仅更新 Observer 0.5.15 的独立本地 tgz，目录 `docs/tmp/task-detail-fb5f9b8`；包 SHA256 `7D0903E91871C7E72D8B54E76283337FAC3FC82DDC6DF0BEB5D7CCED16230E24`。UI 源码与安装文件 SHA256 `71FFE71B60956837BCFB4978C500FF02995B94A227E12D45641B2B5E0E70522D`，profile patch 未变化。

PID 46604 同时监听 3080/18998；health=ok、inboundProcessing=true、recoveryIssueCount=0；认证 Web HTTP 200。任务回读 73 条（72 completed、1 waiting），其中 5 条 workflow-v2。没有重跑任务或发送测试消息。备份在 `D:/dsh_home/backups/task-detail-20260926-fb5f9b8`，包括 profile、控制库和 Domain 存储；未变更数据结构。
