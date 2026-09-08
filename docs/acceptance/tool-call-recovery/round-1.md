# Round 1

## 结果

- `node --test test/topic-runtime.test.js test/task-result.test.js`：43 项通过，0 项失败。
- `npm test`：261 项通过，0 项失败。
- 已覆盖参数错误零副作用、路由回执恢复、请求替换、消息事实版本变化、回复回执恢复、未知回复零副作用、lossless JSON 与 Task 结果精简错误。

## 待完成

- 合并后从最新 `main` 安装本地 profile，并回读 Runtime、DWS 与 API。
