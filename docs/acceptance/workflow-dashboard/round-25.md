# Round 25：主线集成与发行包核验

2026-10-13，功能检查点 `7d40832` 已合入 `origin/main` 的 `f1487e0`，合并提交 `a629a8d`。仅针对受影响路径复测，没有运行全量 pnpm test，也没有部署、调用真实数据库或钉钉外发。

## 源码与运行验证

- 最终 UI/API/启动与合同字节十文件联合组：133/133，exit 0，0 fail/skip/cancelled；测试前后七个关键源码 SHA 不变。命令及摘要见 [backend-final-summary.json](backend-final-summary.json)。
- 原生消费/配置/reset/connector：23/23；UAT 构建失败 service 回归 4/4；源码上传及证据 19/19。每组各一次，完整命令见 [runtime-verification.md](runtime-verification.md)。
- 真实 Edge headless：round-18 配置 16/16、round-19 工作流/存储导航 36/36、round-20 上游任务关联 24/24。同一 observer SHA `80aa9905cdffafde417b800f87568748902c16932d62dd3dd592f50b5d7f13f4`；API 使用隔离夹具，不把浏览器结果当正式部署证明。
- strict 前端静态审计 0 findings；静态结果不替代浏览器交互证据。
- 历史定义恢复依据 [historical-definition-verification.md](historical-definition-verification.md)，不得将不同发行字节生成的记录摘要直接互比。

## 构建、打包与独立读回

```powershell
pnpm install --frozen-lockfile
node scripts/build-web-client.mjs
New-Item -ItemType Directory -Force docs/tmp/workflow-dashboard/packages
pnpm pack --pack-destination docs/tmp/workflow-dashboard/packages
pnpm --dir packages/dingtalk-dsh-assistant pack --pack-destination ../../docs/tmp/workflow-dashboard/packages
pnpm --dir packages/dingtalk-dsh-observer pack --pack-destination ../../docs/tmp/workflow-dashboard/packages
```

三个包均为 1.0.0，以内容 SHA256 识别，不以版本号声称已安装。Assistant README 最后补充 reset 语义后重新打该包；没有改源码或重复无关测试。

Python 标准库 `tarfile` 逐包遍历文件，拒绝越界路径、node_modules、docs/tmp、数据库和 .env；逐字比较包内全部 128 个 JavaScript 文件与对应源码、3 个 Markdown 文件与对应文档。独立校验新 `workflow-configuration.js` 已入包，credentials 正式依赖固定为 0.1.2-rc.1。包长度、SHA 和八个关键源码 SHA 见 [package-check.json](round-25/package-check.json)。压缩包与全日志仅保留 docs/tmp，可按上面命令再生成。

默认原生 credentials-local 是明文持久化；Web 脱敏不代表磁盘加密。已适配消费者使用托管值，旧平台配置文件没有自动迁移。
