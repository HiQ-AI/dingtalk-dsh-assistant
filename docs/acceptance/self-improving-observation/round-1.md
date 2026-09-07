# Round 1

## 结果

- 定向：`node --test test/store.test.js test/runtime.test.js test/http.test.js test/observer-client.test.js test/topic-migration.test.js`，91/91 PASS。
- 全量：`pnpm test`，239/239 PASS。
- `git diff --check`：无空白错误；仅提示工作区 LF 将按 Git 配置转换为 CRLF。

## 关键证据

- 只有 Task 当前叶子、当前 `inputVersion/runSequence` 可以提交观测。
- `query → index → topic-read/adoption → live-verify → outcome` 顺序由 Store 拒绝非法越级。
- 原始查询、文件路径、正文、工具结果不在持久化 schema 中。
- `positive` 必须同时满足现场验证 passed 与 `live-verified`。
- 看板只在用户展开 Task 卡时读取观测，不加入 5 秒全局轮询。

## 边界

- 本轮未安装或部署到正在运行的本机 DSH Web，因此没有真实新 Task 的业务 E2E。
- 历史 Task 没有结构化数据，页面按设计显示“旧数据未观测”。
