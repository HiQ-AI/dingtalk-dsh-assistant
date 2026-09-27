# 旧版首次维护切换

## 执行前决策

旧安装没有维护 API。Windows 强制结束以及旧 DSH 五秒超时 SIGTERM 都不能证明业务排空。目标是先通过现有 Cordis live profile 正式关闭 Resident，再在持续独占所有权下完成安装；禁止先查空闲再无围栏强停。

## 原生证据

旧安装 `@deepseek-ai/dsh/lib/profile-boot-BTzzdrGY.js` 使用五秒 shutdown 上限；`@deepseek-ai/dsh-app-boot/lib/index.js` 的 web profile 默认 live，watchUserPatches 等待 Include 更新。Loader `_dispose` 会先清空 fiber 再 await，所以 inventory 的空 fiber 不能证明完整退出；disabled 更新 await 完整 dispose 后才发 `loader/partial-dispose`。

Resident disposer 依次关闭 HTTP、DWS、workflow 和 runtime。workflow owner 锁释放早于 runtime 旧会话与通知排空，必须同时具备精确完整卸载见证与持续 owner EXCLUSIVE 锁。

## 单一路径

受信 witness ready（nonce/旧 PID/entry）→CAS 追加 disabled→完整 dispose 事件回执→独占 owner 锁→锁内最终快照/旧 PID 核验→停止旧 DSH→备份验证/安装/配置→profile 保持禁用→新版正式 Store enter+seal→关闭 Store→精确移除两个临时块→启动新 Host→认证/历史/包回读→正式 resume。

配置更改共用正式 configure 的 sidecar 互斥锁并验证 SHA；不重新序列化秘密/!!js。所有不确定性保持禁用/停机，不绕过。首次升级维护事件明确来自离线 CLI 真实进程，不伪造旧 Host 许可。临时脚本固定功能、不接纳任意 JS。预检 `-Bootstrap -Check` 零写，不实际挂载 witness。

## 验证边界

隔离 fixture 证明 CAS、配置保持、精确事件过滤、owner 互斥、正式 seal 后关闭与不同进程 resume。首次实际旧 Host 的 live reload/完整 witness 只在用户授权部署中运行并独立回读；测试不冒充已部署。
