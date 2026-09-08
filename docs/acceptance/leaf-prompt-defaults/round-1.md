# 第一轮：源码与独立浏览器

- 基线：origin/main e087530。旧 client.js 使用 fieldset 无折叠；Runtime 空配置仅一句兜底，非空时整段由用户配置提供。未补采旧版浏览器截图。
- `node scripts/build-web-client.mjs`：重新生成发布 bundle。
- `node --test test/runtime.test.js test/client.test.js`：73/73 通过。新增测试覆盖空补充、新建、动态追加、无历史恢复、清空仍有内置规则，主会话不注入；已有多流程组合回归通过。
- `pnpm test`：262/262 通过，0 fail、0 skipped。
- `node docs/acceptance/leaf-prompt-defaults/scripts/browser.mjs <playwright/index.mjs> <react-dom/umd/react-dom.development.js> <截图目录>`：真实 Chrome/React/发布 bundle，API 为隔离 fixture，默认九项折叠、Enter/Space 展开收起、改名保持展开、收起不丢正文、保存失败保留草稿、保存回读、重载折叠、新增/删除、空列表均通过；390px 无横溢出，pageerror=0。人工检查窄屏截图，折叠列表与现有输入框视觉一致。
- Premium strict 静态扫描：sourceRoots 限定实际 Assistant 包，0 findings；未配置产品设计清单，不声称完整设计契约审计。界面所有权与复用决策记录在 spec。首次默认扫描遍历依赖过慢后停止，改用工具支持的 sourceRoots。
- 初次新增测试因主会话 section.text 支持字符串/函数而失败，修正测试读取器后通过；初次浏览器测试因 textarea label 包含默认正文、exact 匹配失败，改为标签前缀匹配后通过。均为测试假设问题。

本轮未部署；浏览器 fixture 验证不代表真实模型行为或真实 Runtime API 保存。
