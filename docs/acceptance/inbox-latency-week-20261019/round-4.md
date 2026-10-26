# 分阶段详情与组合验证

本轮记录实际结果，不是最终通过报告；SG2 未冻结，不宣称全部完成。原任务根唯一 goal/matrix 保持权威，本文件不是第二份目标。

## 浏览器 PASS

命令（从实施 worktree）：

```powershell
node docs/acceptance/inbox-latency-week-20261019/scripts/verify-inbox-browser.mjs --root . --output docs/acceptance/inbox-latency-week-20261019/round-4/ui --react-dom <react-dom-18.3.1-directory> --playwright <playwright-index.mjs>
```

- Edge `156.0.4314.42`，完整 Observer SHA256 `f6291d25fadbc0187c0b71c0895196fe19dd1c4d2a6033ec18eb576016d58eb6`。
- 5 项：旧 Topic/新来源/忽略/未知/负时/跨夜；详情独立来源收束与通知；原生 details 键盘 Enter 关闭及打开并核多回合关联字段；真实状态菜单过滤；刷新不产生虚假成功。
- `errors=[]`、`writes=[]`。详情截图已目视确认焦点框、共享区间、attempt 和请求；桌面与窄屏保留既有表格阅读行为。
- 边界：真实 React/ReactDOM + HTTP handler + 合成 runtime；宿主 slots/primitives 为适配替身，不是已安装 DSH 完整部署。所有固定业务地址 GET 重定向 fixture；外部连接、非 GET 阻止。没有模型调用、生产 DB 或钉钉写入。
- 截图 PNG 本机保留，不入库；脚本可再生成。结果 JSON 与源 SHA 可提交。

## 定向组合 PASS，但有明确跳过

```powershell
node --test --test-concurrency=1 test/http.test.js test/observer-client.test.js test/dynamic-task-store.test.js test/task-message-projections.test.js test/notification-pending-source.test.js test/coordination-sessions.test.js test/task-notification-delivery.test.js
```

`round-4/unit.log`：243 tests，241 pass，0 fail，2 skipped，19584ms。两个 skip 是缺 native profile 的真实慢规划通知用例；不能计为 PASS，后续带完整 profile 补跑。此后增加 Observer 详情行为测试，单文件 31/31 PASS（无 skip）；组合总数需最终重跑，不把旧数量改成新数量。

永久反例覆盖同 messageVersion 下 unitRevision 变化使旧语义戳失效；已 routed 的来源重新 pending 仍挡住旧回复；旧通知无版本不计 E2E；旧版本 Topic 不显示为当前关联；未知/缺时/负时不归零；多个 turn 同 request 使用不同 span。

## 原生组合未完成

在中间实现上启动带完整 native profile 的五文件组合。SG1、独立协调及两项真实慢规划通知已跑通过；`native completion race drains then resumes the original execution without replaying its shell effect` 约 19562ms 显示失败。随后中止移动源码下的组合，`round-4/native.log` 没有最终汇总，不作通过证据。需要冻结 SG2 后定位具体失败并完整复跑；不把中途成功项目凑为全绿。

## 构建与打包阶段

`node scripts/build-web-client.mjs` 和生成文件 `git diff --exit-code` 通过；`node scripts/test-suites.mjs check` 验证 308 文件映射各出现一次（不是 308 文件测试通过）。使用现有 `pnpm pack` 配方生成 root/Assistant/Observer 三包到 `docs/tmp/packages`，读回文件大小 39737 / 401568 / 60937 bytes。SG2 未冻结时的产物只为预验证，不能绑定最终源码；最终需重打包并运行真实解包测试。

不触发 CI、不安装、不重启、不合并、不部署。
