# Round 13：最终配置与保存途中跳转通过

日期：2026-10-13。`configuration 13` 的 16 项检查全部通过，原始结果见 `round-13/browser-results.json`。

新增用例明确持有普通变量保存响应；在保存期间切至工作流并打开另一个秘密变量的「查看配置」，然后释放保存响应。最终选择正确的秘密变量，已保存值仍不回显；重新选择原普通变量可读到刚保存的新值。此用例验证 busy 期间目标不被吞掉，保存完成后继续导航。

普通/JSON/secret、初始加载/未提供服务/错误重试、失败与 CAS 保留、未保存保护、绑定及反向跳转、停用确认/取消零写、过期读取、键盘与 390px 等原有 15 项继续通过。

- 完整 Observer 源码 SHA256：`8789fe453f32795ed9ce8849faeb2d5bcec80653b1f3d8be69b56b51059e059f`。
- Edge 155.0.4283.45 headless，真实 React 18 与隔离 DSH/API 夹具。
- 10 次写入全部为白名单变量/绑定夹具请求；`pageErrors`、`unexpectedWrites`、`nativeDialogs`、`unexpectedRequests` 均为空。
- 截图可再生成至本地 `docs/tmp/workflow-dashboard/round-13/`，不入库；不接触真实凭据、运行实例或钉钉。

```powershell
node docs/acceptance/workflow-dashboard/scripts/verify-workflow-browser.mjs C:/Users/64554/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright configuration 13
```
