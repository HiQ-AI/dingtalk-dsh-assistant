# 第 1 轮：前端交互隔离验收

## 范围与结论

真实 React/ReactDOM 渲染当前完整 Observer 源码，采用独立 headless Edge；DSH 外壳、宿主 primitive 和只读 API 为替身。输入是本机真实任务及执行关系快照，未将私有任务/群 ID 或快照内容纳入版本库。两族 13 次执行只返回最新 2 张卡片。18 项断言通过，浏览器错误 0，写请求 0。

这轮证明隔离 UI 交互，不等于真实生产 API、部署或两项业务重新验收。服务端权限、聚合和数据行为由后端定向验收独立证明。

## 实跑

```powershell
node --test test/observer-client.test.js
node docs/acceptance/task-card-execution-history/scripts/verify-browser.mjs <本机task-inventory.json> <本机lineage.json>
```

定向测试 12/12 通过；浏览器脚本退出码 0。脚本可通过第 3 个参数指定 Playwright module URL，默认使用本机 Codex bundled runtime。真实 React 及匹配 ReactDOM 从项目 pnpm 依赖读取，缺失会停止，不以模拟 hooks 替代浏览器。

## 断言

- two-real-families-two-cards
- card-and-step-source-unchanged
- history-lazy-seven-executions
- keyboard-history-disclosure
- latest-steps-preserved
- history-pr-link-click-and-href-without-external-navigation
- review-failed-deployment-and-successful-rebuild-in-history-and-runs
- keyboard-switch-physical-detail-and-output
- refresh-keeps-historical-execution
- narrow-no-detail-overflow
- keyboard-return-latest
- merge-six-executions
- cancelled-engineering-success-visible
- history-error-retry
- detail-error-hides-previous-target-and-steps
- detail-error-retry
- slow-detail-loading-clears-old-content
- stale-detail-response-cannot-replace-selection

## 独立回读与视觉核对

读取 `docs/tmp/task-card-execution-history-browser/browser-results.json` 再次确认 passed=true、errors=[]、writes=[]。

最终源码 SHA-256：`a4b3250fd560f2197dd5039011b1334dad71f0a747df2ca3b146b9f28835e3bb`。浏览器版本：`154.0.4258.37`。

卡片 renderTaskCard 至 bucketColumns 与执行步骤 section 至最新产出 section 对比 HEAD，统一 Windows 换行后逐字符完全一致。最新产出仅补链接渲染，不改步骤。历史与结果支持 HTTPS/HTTP 地址、已有 Markdown 描述链接；单元断言证明 javascript 协议不会形成链接。浏览器点击旧 PR anchor 时预防外部导航并独立读取 href/rel，未打开外部 PR。

已检查 1440px 桌面与 390px 窄屏截图；窄屏任务详情无横向溢出，现有长标题自然换行。截图与结果仅保存在 `docs/tmp/task-card-execution-history-browser/`，不提交二进制。原有全局导航溢出方式保持原实现。

## 阶段结果夹具复核

阶段摘要夹具已按当前 `workflow-service.taskExecutions` API 契约改为读取全部执行 runs；不再取 currentPlan。名称依次复用物理详情匹配 runId 的阶段标题、taskWorkflowCatalog.label、服务端同款“工程执行”回退。lineage runs 为时间升序，与 catalog rowid DESC 后反转的输出一致。

修正夹具后重跑仍为 18/18、退出码 0。第 7 次草稿执行顶部历史摘要明确展示 4 条真实阶段记录，包含失败部署与成功重建；底部本次执行过程也保留这 4 条。归一化第 4 次历史摘要只展示真实完成的 1 条工程记录，不展示未实际执行的受阻合并/部署节点。没有修改 UI 源码。JSON 和截图已重新生成。
