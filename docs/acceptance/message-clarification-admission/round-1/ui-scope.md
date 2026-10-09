# 授权状态显示验收

本次只向既有状态映射和 SelectMenu 增加“等待授权”，复用 Button、Menu、StateDot、tableStatusTag 和现有颜色/排版。设计依据为 docs/manual/observer-design.md，不改布局、token 或全站导航。按照仓库非源码产物必须放 docs 子目录的规则，本轮不新增根 DESIGN.md；product-admin strict 审计实际报告一项既有 contract.design-missing，不声明全站 Premium 合规。

隔离浏览器使用完整 Observer 源码、真实 React、独立 Edge headless；宿主 Menu 采用可操作语义替身。API 全部拦截并提供三种等待状态，不连接运行实例。验证三种独立标签、三种筛选、窄屏键盘筛选共 5 项通过，0 页面错误、0 写请求。它证明原 SelectMenu 传递选项及筛选回调正常，不证明宿主 Menu 弹层布局或全部宿主键盘约定。窄屏沿用现有宽表横向滚动，右侧筛选操作可见，左侧状态需要横向滚回；未扩展为全表响应式重设计。

复现：`node docs/acceptance/message-clarification-admission/scripts/verify-authorization-browser.mjs <playwright模块目录>`。截图只保留本地，不入库；结构化结果见 authorization-browser-results.json。初次测试机器 C 盘临时目录空间不足，使用 D 盘 docs/tmp/authorization-state-tests 作为 TMP/TEMP 后通过。
