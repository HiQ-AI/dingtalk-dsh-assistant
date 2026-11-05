# 第 12 轮：隔离 Host 与凭据预检（阶段记录）

日期：2026-11-04

## 范围与结论

本轮记录当前已完成的无付费隔离验证和凭据预检，以及后续获授权路径。此前宿主低内存停止通知作为历史保留；B 自身会话限制仍有效。C 已获 SG3 唯一执行权及只读凭据授权，可按范围进行接入、预检与原五例 A/B。凭据解析预检阶段模型调用为 0；随后 C 已完成 773 baseline 的结构终态，语义待 D 审，candidate 正由 C 串行推进。五例 A/B 尚未完成；本报告不代表生产发送或整体验收通过。

## 隔离回归

`round-12/isolation-tests.tap` 报告 5/5 pass、0 fail/skip/cancel，耗时 3150.9299 ms。覆盖两项纯函数边界与三项合成 Native：历史提取限定请求、guard 仅接受可信请求实际可见短引用、拒绝评测文件/执行工具并隔离副作用、显式模型适配器直接处理协调请求、隔离 Host 将规范动作和通知写入真实账本。三个 Native 生命周期共九个 prepare/business/cleanup 阶段均 `aborted=false`。

`round-12/isolation-test-versions.json` 绑定 7 项 before/after 内容 hash 一致，`drift=[]`；TAP SHA256 为 `b0191ab16271a41c305f45efddbe481100433e819a156c9a227ce35c424c98d3`。该清单只绑定当时五项隔离测试，不包含后续新增的四项脱敏证据 blob。测试使用真实框架、Store 与 Host 执行路径以及合成输入；不证明原五条历史业务的完整 Host/provider 路径、真实模型语义或钉钉送达。

## Provider 凭据预检

`provider-credential-preflight.json` 与 `provider-credential-powershell.json` 记录早期 Bash 和 PowerShell 7 隔离调用：既有配置 stanza 显式绑定，provider 官方 schema 可接受，隔离 Host 可加载；这两份文件化 probe 均为 `credentialResolved=false`、`modelCalls=0`，清理完成。之后新增的零模型隔离预检原始 stdout 由 PowerShell 工具直接捕获：`{"credentialResolved":true,"cleanupCompleted":true,"modelCalls":0}`，没有独立输出文件。launcher 通过官方文档解析，在临时子进程环境解析凭据，不加载正式可写凭据服务；formal runtime 未加载，production final overlay 未验证。

因此，早期两份文件化 probe 的 `credentialResolved=false` 历史保留；随后 PowerShell 直接捕获的零模型预检回执为 `credentialResolved=true`、`cleanupCompleted=true`、`modelCalls=0`。该回执无独立输出文件，不代表真实模型调用。用户已授权只读使用现有模型凭据，仅用于原五例隔离子进程临时认证，不输出/落盘/修改正式配置或凭据。零模型接入与 773 两侧 `--check` 已完成；五例完整语义及性能验收仍未完成，不预告成功。

## 交接与边界

- A 已有的整合后定向单元测试 250/250 及其 13 项 blob 绑定继续按 round-9 记录；不与本轮隔离 5/5 合并成整体全绿。
- 整合后 Native 中断前 5 项 business 超时、另 7 项通过及宿主停止通知在 round-9 保留。round-9 当时逐项根因未知；round-10 已逐项证实旧测试脚本未消费路由 `nextCall`，原断言及时限 5/5；round-11 human 整文件 20/20（已包含原五项，不重复累加）。宿主停止不等于五项失败根因，历史 FAIL 保留但不称当前仍未知。
- 773 baseline 与 candidate 已有真实模型调用及结构终态，stream 计数为 8/5；语义待 D 审。五例 A/B 继续由 C 串行执行，完整结果尚未完成；本轮不记整体通过。
- 不创建 PR、不 push、不部署、不触发 CI、不发真实钉钉消息。
