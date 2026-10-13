# Round 0：浏览器基线

日期：2026-10-13。运行新脚本的 `baseline 0` 模式，真实 React 18 与完整 Observer 源码在独立 Edge 155.0.4283.45 headless 浏览器中渲染。

- 现有导航为群消息、话题、任务看板、人工介入、归档任务、告警；没有「工作流」Tab。
- `pageErrors=[]`、`writes=[]`、`unexpectedRequests=[]`。
- 源码 SHA256：`9670ed295b99b00700bb2e12062434c0ddf860fe9795f35d124f4cab56691ac8`。
- 原始结果：`round-0/browser-results.json`。本地截图：`docs/tmp/workflow-dashboard/round-0/baseline-desktop.png`，不入库。

复现命令（当前脚本 baseline 模式仅适用于变更前源码）：

```powershell
node docs/acceptance/workflow-dashboard/scripts/verify-workflow-browser.mjs C:/Users/64554/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright baseline 0
```

此轮记录新增入口前的缺口。API 与 DSH 宿主为隔离夹具，不访问本地运行实例或钉钉，不代表真实部署或业务端到端验证。
