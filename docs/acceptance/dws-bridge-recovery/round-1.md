# Round 1

日期：2026-09-02（Asia/Shanghai）

## 通过

- `node --test test/dws-adapter.test.js test/dws-bridge.test.js test/http.test.js test/runtime.test.js`：54/54 通过。覆盖空订阅初始健康、listener ready 后才开始回补、非正常退出与 `done` reject 重连、ready 超时、旧 generation 隔离、告警记录与恢复的交错顺序、单群补拉失败隔离、范围读取无 500 条上限、HTTP 健康降级和 Runtime 告警前缀回收。
- `pnpm test`：112/112 通过。
- `npm pack --dry-run`（`packages/dingtalk-dsh-assistant`）：成功列出 17 个发行文件，其中包含 `dws-adapter.js`、`dws-bridge.js`、`http.js`、`resident.js` 和 `runtime.js`。
- `git diff --check`：通过，无空白错误。

## 未执行边界

- 尚未合并或安装本分支到当前 DSH Web，因此没有把测试结果表述为真实 DWS listener 已恢复。
- 未人为发送真实群消息，真实入站、Decision 和群回复回读仍需在部署后的可控群单独验证。
