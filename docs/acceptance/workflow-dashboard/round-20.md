# Round 20：复用上游任务详情关联验收

2026-10-13，复用上游完整任务详情浏览器脚本，24/24 PASS，证据从隔离临时输出复制至 `round-20/browser-results.json`。未重写长步骤夹具。源码 SHA256 与 round 18/19 完全一致：`80aa9905cdffafde417b800f87568748902c16932d62dd3dd592f50b5d7f13f4`。

覆盖任务会话与步骤会话入口、sessionBound 门禁、步骤阅读与分页、跨页面刷新保持阅读、过期响应、当前步骤删除后焦点恢复、切换任务不继承旧提示、无工作流状态以及窄屏/暗色/键盘。`errors=[]`、`writes=[]`，未连接业务运行时或用户浏览器标签页。

```powershell
node docs/acceptance/task-detail-redesign/scripts/verify-browser.mjs round-20
```

浏览器 Edge 155.0.4283.45，React 18.3.1，宿主槽位/会话接口/API 为合成替身。截图等原始临时产物位于 `docs/tmp/task-detail-redesign/round-20/`，不提交。
