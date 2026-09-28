# 当前完整步骤浏览器验收

2026-09-29。可复用脚本：`scripts/verify-browser.mjs`。历史脚本硬编码执行切换，无法容纳当前目录规则，因此复用其真实 React/ReactDOM 宿主后新增本脚本。

实跑命令：`D:/soft/node-v24.19.0/node.exe docs/acceptance/task-current-steps/scripts/verify-browser.mjs`。独立 headless Microsoft Edge 154.0.4258.37，真实 observer 源码 SHA-256：`1c96951726acc008dcff1b4cd197ced3bec52599c6ee48e613347f17037ba53e`。

## 真实完成任务快照重放

| 匿名任务 | 当前节点数 | 继续阅读次数 | 结果 |
| --- | --- | --- | --- |
| 1 | 30 | 14 | PASS |
| 2（归档入口） | 3 | 6 | PASS |
| 3 | 30 | 57 | PASS |

三个任务均验证默认正文可读、长文尾段完整读取、当前结果、无历史入口、键盘卡片打开/返回/分页按钮、1440px 和 390px 详情无横向溢出。

## 模拟变化场景

七项 PASS：详情刷新失败保留正文并重试；删除正在阅读步骤后提示并聚焦相邻步骤；步骤移除/新增无重复；未变产物在无关详情版本变化后保留展开长文及已读分页；迟到旧正文不混入当前正文；空列表未定计划不假完成；待定阶段占位不假完成。

## 边界

宿主 primitives 与 API 为隔离替身，正式 18998 请求全部截获，非 GET 请求全部拒绝。五秒自动刷新在隔离宿主内冻结，版本变化由显式刷新触发，避免夹具竞态；正式运行刷新尚待现场只读核验。页面错误 0、写请求 0。未发消息、未重跑任务、未部署。截图、正文快照和原始日志仅保存在 `docs/tmp/task-current-steps/browser/` 且不提交，本汇总不含任务 ID、业务标题或真实正文。

`verify-live-browser.mjs` 另用于部署后正式 DSH Web 独立 context 只读回查，读取当次启动日志中的认证 URL，不持久化凭据；当前尚未运行。

## 客户端定向测试

`D:/soft/node-v24.19.0/node.exe --test test/observer-client.test.js`：14 tests，14 pass，0 fail，0 skipped，duration_ms 549.2137。覆盖当前目录、旧详情别名、稳定步骤身份、未定计划进度、正文分页版本隔离、未变产物阅读状态及移除步骤相邻定位。语法检查和 `git diff --check` 通过。
