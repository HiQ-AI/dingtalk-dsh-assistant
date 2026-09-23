# 第 2 轮验收：按信息用途重新设计

第 1 轮虽然压缩了内容，但仍把非决策信息放在卡片内。按用户反馈重新划分为默认概览、异常提示、归档前核对和归档后记录。实现决策见 `docs/spec/task-card-information-hierarchy.md`。

## 浏览器结果

完整 Observer 源码与真实 React 在 Edge Chromium 中渲染隔离数据。脚本 `scripts/verify-browser.mjs` 的 18 项检查通过，结果见 `round-2/browser-results.json`。

- 默认卡片不出现“待归档清理”、目录路径、文档清单或正常的“通知已送达”；保留业务结果、待处理通知与归档操作。
- `topic_request_retry_exhausted:<id>` 在卡片显示“系统协调受阻 · 待恢复”，长 ID 不进入正文。
- 点击“检查并归档”才显示操作核对；借用目录明确保留原处，任务自建目录明确迁出文档并清理。归档失败的摘要在卡片，原始原因在预览；取消预览未发写请求。确认后仅向对应任务发出一次由夹具模拟的归档 POST，任务从看板消失。
- 已归档任务的目录记录可按需查看；归档动作按钮与打开会话按钮成为独立控件。
- 390px 窄屏的 document 宽度为 390px、任务看板 366px，无页面横向溢出；人工检查 `card-narrow.png`、`archive-narrow.png` 和 `observer-desktop.png`，文字与操作不重叠。
- 浏览器脚本记录 JavaScript 错误 0、非预期写请求 0、模拟归档 POST 1 次。DSH 外壳、UI primitive 和 API 使用隔离替身；未接正式 profile、未触发真实归档或群消息。

## 本地测试

- `node --check packages/dingtalk-dsh-observer/web-client.js` 与浏览器脚本语法检查通过。
- `node --test`：632 项通过，0 失败。
- Premium 严格静态审计：0 finding、0 error。
