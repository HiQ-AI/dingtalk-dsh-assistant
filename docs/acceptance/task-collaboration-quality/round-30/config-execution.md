# R30 PTY 候选部署门禁更新

本轮职责仅为 PTY 双包部署 helper、相应测试和 runbook 更新；不改已封板 Claude adapter，不安装或覆盖任何现场包。

PTY 实施方确认新候选：`@deepseek-ai/dsh-subprocess-local@0.2.1-rc.2.pty.2`，精确依赖 `node-pty@1.2.0-beta.15.dsh.2`。保持 subprocess-local 的 `lib/index.js` 关键文件校验；node-pty 必须同时校验 `lib/windowsPtyAgent.js`、新增 `lib/windowsTerminal.js` 以及 `lib/unixTerminal.js`。

已更新 `scripts/pty-package-upgrade.mjs` 固定双包版本与必备文件集合，拒绝省略退出码顺序修复文件。保留原两包提案、压缩包身份/依赖/SHA、manifest CAS、零写 check、官方安装后真实 base→provider→node-pty 消费路径核验。

已更新 `test/pty-package-upgrade.test.js`：保留原测试，增加缺 windowsTerminal 文件、旧 dsh.1 版本、实际消费路径仍是旧 windowsTerminal 字节的拒绝断言。`node --test test/pty-package-upgrade.test.js` 3/3 PASS、0 skipped，16.0 秒退出 0；证据 pty-upgrade-tests.log。

runbook 同步新版本、新文件与新持久目录约束，明确旧候选目录/包和证据不可覆盖。独立回读 Claude adapter SHA 仍为 `fef786be61417bcaf2f6d42134bd5a30a80efdd284649e3a5a26da87fc0cc415`。git diff --check 通过，仅已有 suite-map 换行提示。

本轮 helper 测试是隔离合成包的正反例，不能替代真实 node-pty 延迟退出码修复、原生进程复验或正式部署；这些由主验证链完成。
