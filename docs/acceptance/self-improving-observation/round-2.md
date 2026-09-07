# Round 2

## 结果

- 在补充 Runtime 提示词边界后执行 `node --check packages/dingtalk-dsh-assistant/runtime.js; node --check packages/dingtalk-dsh-observer/web-client.js; pnpm test; pnpm pack --dry-run`，本轮 FAIL。
- `runtime.js` 的模板字符串内新增未转义反引号，导致语法检查失败；全量测试因此为 172 PASS、2 FAIL。
- `pnpm pack --dry-run` 不支持 `--dry-run` 参数，不能作为打包预检命令。

## 处置

- 转义 Runtime 模板字符串中的反引号。
- 使用项目可执行的 `npm pack --dry-run` 做零落盘包内容预检。
