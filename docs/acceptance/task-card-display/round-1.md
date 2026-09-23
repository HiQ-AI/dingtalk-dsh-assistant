# 第 1 轮验收

## 环境与结果

- `pnpm install --frozen-lockfile --prefer-offline`：工作树依赖安装成功。
- `node --test`：632 项通过，0 失败。
- `node docs/acceptance/task-card-display/scripts/verify-browser.mjs <含 playwright 的 node_modules>`：真实 Edge Chromium 153、React 18、完整 Observer 源码渲染，10 个既有状态/交互检查及新增归档、等待断言均通过；浏览器错误与写请求均为 0。结果见 `round-1/browser-results.json`。
- 390px 窄屏：document 宽度 390px，看板宽度 366px，无页面横向溢出。人工检查了 `round-1/observer-desktop.png` 和 `round-1/archive-narrow.png`：目录路径折行，文档只显示文件名，展开后无重叠。
- Premium 严格静态审计：0 finding、0 error；`node --check` 和 `git diff --check` 通过。

## 边界

浏览器使用隔离 API、DSH 外壳及 UI primitive 替身，写请求一律阻断；未安装到本地正式 profile，未触发真实归档或钉钉发送。
