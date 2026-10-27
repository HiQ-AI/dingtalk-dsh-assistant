## 问题与结果

原模型配置使用浏览器 select，统筹、协调候选还限定在各自当前提供方，与 DSH 原生菜单的搜索、分组和候选内容不同。本次三个字段直接复用宿主 ModelSelect，并共用同一份全提供方 catalog；各自保留选中项。

## 实现与关键位置

`packages/dingtalk-dsh-assistant/client.js:48`：通过宿主公开 SlotRegistry 注册视图取得现有组件，目录来自原生 RPC：

```js
component: () => ctx.slots.entriesOfSlot('conversation.input.model')[0]?.component,
```

`packages/dingtalk-dsh-assistant/client.js:84`：组件复用宿主菜单、搜索、提供方分组、深度、键盘与材质；三个目录快照引用同一 groups。适配回调只更新各自配置草稿，不调用当前会话的 selectModel，统一点击保存才写入。

`packages/dingtalk-dsh-assistant/task-resident-runtime.js:93`：跨提供方默认模型保存保留完整身份，并沿原生 resolveCallConfig 预检：

```js
const proposedSelection = { provider: input.provider === undefined ? old.provider : input.provider.trim(), model: input.model === undefined ? old.model : input.model.trim() }
```

继承推理深度保留独立复选框。同步 README、DESIGN、部署说明，重新生成 Web bundle；前置分析与验收证据归档于 docs/spec/native-model-picker-consistency.md、docs/acceptance/native-model-picker/。

## 验证

- [x] `node scripts/build-web-client.mjs` 及 `node --test test/client.test.js test/web-client-build.test.js test/task-model-config.test.js`：16 passed、0 failed、0 skipped；含官方模块导入、共享目录、同名跨提供方、提供方保存预检及失败回读。
- [x] `pnpm test:release-smoke`：14 passed、0 failed、0 skipped。
- [x] `node scripts/test-suites.mjs check`：309 files、historical 3、deleted 0；没有退出覆盖。
- [x] Chrome 隔离页加载实际宿主 0.2.1-rc.2 ModelSelect 与真实插件 bundle，三个候选数组比较 allThreeEqual=true；搜索保留两提供方同名模型，保存回执 provider=openai-codex/model=sol；空搜索、清除、Down+Enter、Escape 与焦点返回通过，浏览器错误日志为空。
- [x] 使用实际宿主主题变量核对原生圆角、菜单材质、标题与勾选；静态 UI 审计 0 errors/0 warnings。
- [ ] 窄屏：viewport 请求未生效，实际 innerWidth 仍2560，已重置，不冒称通过。
- [ ] 完整宿主设置页装配与正式本地部署：本轮未执行；隔离 slot/目录/HTTP 适配器不等于正式宿主验证。

## 风险与边界

复用宿主当前注册组件及原生目录协议，依赖其 ModelSelect 注入合同；组件未就绪明确提示，不回退插件自画菜单。三个字段共享候选，不强制相同选中值。没有改真实会话模型、发送消息、重放任务、修改存储 schema 或触发 CI。既有独立配置与原会话身份保留。截图仅本地保留且有摘要和再生成步骤，大二进制不入库。
