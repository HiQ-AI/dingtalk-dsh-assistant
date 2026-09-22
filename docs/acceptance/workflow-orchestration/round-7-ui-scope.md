# 本轮界面核验范围

此次为既有中文运行看板的状态语义核验，不建立新应用、不重设计全局样式、不修改真实 profile。仓库根无 DESIGN.md；遵循用户所有非源码文档放 docs 的要求，将本轮核验范围记录在此。既有 runtime CSS tokens 和共享 primitive 继续为视觉依据。

业务依据：workflow-orchestration-contracts.md 的成功、取消、失败、历史未知与通知独立事实；task-progress.js 中稳定 stageId 与有效产出。界面不得通过 state=completed 推导全部阶段完成。

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| CRUD | observer 既有任务卡片 | Runtime workflowProgress / notificationIntents | 只读状态与已有导航 | round-7/browser-results.json |

本轮沿用颜色：DSH base/layer、brand、success、warn 变量；字号和间距沿用 observer 的 ui 常量。语言 zh-CN，系统中文字体。同期群聊页作为导航、刷新与状态标签的相邻参照。

隔离浏览器使用完整 observer 源码、真实 React/ReactDOM、独立 Edge headless context；API、DSH shell、共享 UI primitive 是无副作用替身。核验原生任务卡片控件的 Enter/Space 和可见焦点，不声称原生 DSH 菜单、认证、会话导航或实际服务已验证。

静态审计默认无 profile 配置，返回零项不能证明产品契约齐全；另用 product-admin 配置显式审计 observer 范围。缺失根 DESIGN.md 将如实保留为审计未满足项，不以临时文档冒充已建立的全局设计体系。

视觉观察到的既有边界：窄屏仍沿用每列近一屏高度和内部滚动，空列造成较长滚动；卡片内部滚动条原代码隐藏。此次不修改布局或借机修全局样式。
