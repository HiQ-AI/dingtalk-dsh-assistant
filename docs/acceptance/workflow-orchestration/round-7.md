# 第 7 轮：运行看板状态语义的浏览器核验

日期：2026-09-22。使用已安装 frontend-design / frontend-design-premium 技能的核验流程；不重设计现有界面。

## 浏览器结果

```powershell
node docs/acceptance/workflow-orchestration/scripts/verify-observer-browser.mjs <workspace-dependencies-node_modules>
```

依赖目录由 Codex `load_workspace_dependencies` 提供，不固化用户机器路径。脚本加载工作区 React 与匹配版本 ReactDOM，启动独立 headless Edge context，仅开放夹具本地服务器，并拦截 resident API 返回受控数据。生产地址不发起真实网络请求，非 GET 请求一律拒绝。

10 项检查通过：四种终态标签；通知四种状态独立显示；结束不等于全阶段通过；同名不同 stageId 按真实完成标记计为 1/2；Enter 展开；可见焦点；390px 中文单列；窄屏 Space 收起；空列表；读取失败可见。

证据：[browser-results.json](round-7/browser-results.json)、[桌面截图](round-7/observer-desktop.png)、[窄屏截图](round-7/observer-narrow.png)。结果保存当前 observer 源码 SHA-256，浏览器无 pageerror、无写调用；窄屏文档宽 390px、看板宽 366px，无文档横向溢出。截图已实际查看：同名阶段第一项勾选、第二项未选；取消/失败/未知卡片仍为 1/2；通知标签与业务结果并列。

完整 observer 源码和 React 渲染实际运行。DSH 外壳、API、共享 primitive 采用无副作用语义替身，因此不宣称原生 DSH 菜单、认证、生产会话导航或真实服务端已验证。此轮不进行实际归档或其他外部副作用。

## 静态审计

```powershell
python <frontend-design-premium>/scripts/audit_project.py . --mode strict --output docs/acceptance/workflow-orchestration/round-7-premium-audit.json
python <frontend-design-premium>/scripts/audit_project.py . --mode strict --config docs/acceptance/workflow-orchestration/round-7-premium-config.json --output docs/acceptance/workflow-orchestration/round-7-premium-scoped-audit.json
```

默认未配置 product-admin profile 时退出 0、零 findings。显式指定 product-admin/observer 范围后退出 1，唯一 findings 为 `contract.design-missing`：仓库根无 DESIGN.md。用户要求文档放 docs，本轮只做已有状态语义核验，范围和等效依据记录于 [round-7-ui-scope.md](round-7-ui-scope.md)，没有为使审计变绿而虚构全局设计契约。静态 premium 全合规尚未达成；此缺口与 10 项浏览器状态检查通过分别报告。

## 本轮未修改的既有界面边界

- 窄屏沿用每列近一屏高度，空列导致长滚动；内部卡片列表保留原实现的隐藏滚动条。
- DSH 共享 primitive 未在此夹具中按生产样式挂载，截图用于 observer 卡片及状态语义，不用于像素级品牌验收。
- 非本次更改的菜单、归档确认和全站可访问性未扩展审查，不能由该局部通过推导全站合规。
