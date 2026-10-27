# 第二轮验证

## 结论

三个字段直接复用真实宿主 ModelSelect，候选与顺序一致。定向 16/16、smoke 14/14，均 0 failed、0 skipped。正式运行实例尚未安装本轮修订，隔离浏览器不代表生产配置已修改。

## 自动验证

- `DSH_NATIVE_TEST_PROFILE=D:/dsh_home/profiles/web/package.json`，执行 `node --test test/client.test.js test/web-client-build.test.js test/task-model-config.test.js`，输出见 round-2/targeted.log。包含同名跨提供方目录、共享进行中请求、失败保留目录、未调用 session.selectModel、保存前提供方校验与独立回读。
- `pnpm test:release-smoke`：14 passed，见 round-2/smoke.log。
- `node scripts/test-suites.mjs update` 后 `check`：309 files，historical 3，deleted 0。无分类或映射语义变化。
- `node scripts/build-web-client.mjs`：重新生成并由 Web 构建测试独立比较一致。

## 真实浏览器操作

Chrome 在 19097 隔离主机打开实际插件 bundle。宿主 ModelSelect 来自已安装 `@deepseek-ai/dsh-client-ui-model-selection@0.2.1-rc.2` 原始 client.js，通过其真实 apply 注册捕获组件；使用真实 React、原生 primitives、原生 CSS 及实际宿主 body 的 --dsw 主题变量。仅目录 RPC、配置 HTTP、slot 宿主装配为合成适配器，无真实渠道或模型请求。

逐一打开默认处理、统筹、协调菜单，三者菜单文本数组完全相同：GPT-6.1 Sol / Spark / Luna / Sol / Terra / Astra / GPT-6.1 Sol；两个提供方分别是 cortex-gateway 与 OpenAI Codex。读取 DOM 文本比较得到 `allThreeEqual:true`。

搜索 GPT-6.1 保留两个提供方的同名模型。选择 OpenAI Codex 下的 GPT-6.1 Sol，再点击保存，页面回执 provider=openai-codex、model=sol；两个独立字段保持原值。选择仅改草稿，保存按钮随后才可用。当前勾选与提供方身份对应。

搜索 not-found-model 显示“没有匹配的模型。”；清除搜索恢复全部候选；Down+Return 选择 Spark，菜单关闭并聚焦回原触发器。Escape 从模型列表返回根菜单，再次 Escape 关闭。材料样式使用原生 MenuSurface；采集宿主主题后 --dsw-menu-surface-fill=#f8f9fa94，截图可见圆角、材质、提供方标题、选中勾选和高亮。

截图仅本地保留：docs/tmp/native-model-menu-detail.png，不提交大二进制。来源摘要见 round-2/source-hashes.json。再生成入口：

```powershell
node docs/acceptance/native-model-picker/scripts/browser-host.mjs --profile <已安装web-profile> --deps <browser-deps的node_modules> --esbuild <esbuild/lib/main.js> --tokens <从实际宿主body采集的dsw变量CSS>
```

依赖准备复用 coordinator-work-visualization/scripts/prepare-browser-deps.ps1；tokens 只读取宿主 body 的 computed style 中 --dsw- 前缀，以 `:root{变量:值;}` 保存于 docs/tmp，不含配置或凭据。浏览器 fixture 固定绑定 127.0.0.1:19097；所有 fetch 均被合成适配器接管，不透传到真实 18998。原生后端目录 store 类未实例化，会话服务禁止 selectModel。

## 未验证边界

浏览器 viewport 能力请求 390px 后实际 innerWidth 仍为 2560，故未把这次操作算作窄屏验收；已重置 viewport。桌面没有横向溢出。完整宿主插件页装配、窄屏及正式安装后回查仍待后续验证，不把静态审计或隔离主机成功当作这些验证已完成。
