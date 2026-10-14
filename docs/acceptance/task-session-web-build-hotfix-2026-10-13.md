# Web 构建重复声明修复（2026-10-13）

基线：`9eb937cddf8100a2eed1ca4e2925e7d659e6db16`。此次仅修云端源码，未推送、合并、安装或切换现场服务。

## 原因与修复

实际执行 `node scripts/build-web-client.mjs` 后，`node --check packages/dingtalk-dsh-assistant/web-client.js` 原样复现 `Identifier 'IconRefreshOutline16' has already been declared`。client 源码已经定义该符号，旧构建器又向生成工厂注入同名导入；先前手工维护的产物没有暴露这个生成链路错误。之前的组件验证不足以证明可重新构建。

- 移除构建器多余图标声明，唯一实现来自 client 源码。
- 构建器写产物前使用 Node Script 解析完整生成代码；非法输出不会覆盖已有产物。
- 用实际构建器重新生成 web-client.js，固定源码/产物一致性。
- 新增真实子进程构建、重复构建字节一致、node --check、非法重复声明负例及官方 DSH 模块链路回归。

## 实跑

```sh
node scripts/build-web-client.mjs
node --check packages/dingtalk-dsh-assistant/web-client.js
node --test test/web-client-build.test.js test/client.test.js test/observer-client.test.js
```

结果：**30/30 通过，无跳过**。官方链路测试实际使用已安装 alpha2 Cordis/Loader、ClientModuleRegistry 的 manifest/exports 解析与 fetchBundle 资源响应，再运行官方 client-modules 浏览器加载器，通过真实 React seed 和 system.import 加载生成模块。独立只读 probe 也验证同一官方链路；这不是只用 mock 组件判断构建。

无完整 alpha2 profile 的环境会明确跳过官方模块链路一项，不能宣称其通过；两个真实脚本构建测试仍执行。可用 DSH_NATIVE_TEST_PROFILE 指定实际已安装 profile/package.json。Windows CRLF 仅在比较受 Git 行尾转换影响的源码产物时规范化，不跳过语法或模块加载验证。

真实浏览器渲染、百部 Windows 现场复验，以及另外 9 项平台失败的分类仍需现场报告；本补丁不把这些未验证项计作通过。

## 本修复源码 SHA-256

- `scripts/build-web-client.mjs`: `dd8942560fc5a9e06c8a3ba7712c463b9dd1eed21c3001667c1c42d9fde311d3`
- `packages/dingtalk-dsh-assistant/web-client.js`: `355cd3e7720d9dec0a7256adc1382e0bc623aec928ecd0bf3e022aa9c86f67d1`
- `test/web-client-build.test.js`: `02bd0f1832b132a149d8f4609cc70b9d9d9a190b5428c540d8a5b7172e70d6be`
