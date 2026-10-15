# 第二轮

2026-10-15，基线 `b564b925fa50eb29bb550b74fa914ce0bd0cd401`。

## 定向验证

设置 `DSH_NATIVE_TEST_PROFILE=D:/dsh_home/profiles/web/package.json`，执行：

```powershell
node scripts/build-web-client.mjs
node --test test/group-reply-format.test.js test/client-reply-signature.test.js test/task-session-reply-identity.test.js test/dingtalk-dsh-assistant.test.js
node --test --test-name-pattern='configured group responsibility' test/task-session-service-native.test.js
```

前组 24 pass / 0 fail / 0 skipped，日志 `round-2/targeted-tests.log`；后组 1 pass / 0 fail / 0 skipped。真实原生会话测试使用脚本模型与隔离 SQLite/临时工作区，不发送真实消息；它验证模型输入和通知路径，不证明真实模型每次都遵守署名要求。

配置 HTTP 验证历史存储/profile 字段不暴露、旧客户端提交拒绝且其它字段无写入、正常字段仍可保存。格式器保留不同群正文署名，忽略旧覆盖参数。完成、状态和 requester 提问保留原生引用与真实 @，已有通知不重写。系统提示明确按会话职责决定是否署名。

## 隔离浏览器

`settings-preview.mjs` 仅连接内存 fixture。准备 ReactDOM 18.3.1 UMD（不修改项目依赖）：

```powershell
New-Item -ItemType Directory -Force docs/tmp/signature-preview
npm pack react-dom@18.3.1 --pack-destination docs/tmp/signature-preview --silent
tar -xf docs/tmp/signature-preview/react-dom-18.3.1.tgz -C docs/tmp/signature-preview
node docs/acceptance/remove-global-reply-signature/scripts/settings-preview.mjs <解压目录>/package/umd/react-dom.production.min.js
```

通过 Codex in-app browser 打开脚本输出 URL。设置页没有署名字段；名称改为“预览助理,保存验收”后保存、刷新保持；独立 GET `/saved` 回读 `agentNames` 为两个名称，且没有 `replySignature`。截图在 `docs/tmp/signature-preview/settings.png`，不提交二进制，可按上述配方再生成。

## 关联旧测试基线

`test/group-reply-audience.test.js` 为已退役工作流，8项中5通过、3失败。将未修改的 HEAD 中 packages 和该测试用 `git archive` 解出后复跑，仍是完全相同的3项失败：补充通知正文、完成提示自包含文案、真实业务名称文案。基线比较通过，旧套件本身未通过；不扩展到本次范围外修复。

未部署，未发送真实钉钉消息，未运行全量测试。
