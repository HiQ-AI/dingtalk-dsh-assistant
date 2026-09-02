# DWS Bridge Recovery Goal

## 总目标

让 DWS 常驻入站 bridge 在 listener 退出或补拉失败后可恢复，并让本地 Runtime 如实暴露入站健康状态。

## Sub goal matrix

| 子目标 | 状态 | 证据 |
| --- | --- | --- |
| 复现并锁定 listener / 回补失联 | 完成 | 现场 DWS 范围读取与 Runtime 状态对比 |
| 实现 listener 重连和完整补拉 | 完成 | listener、补拉、范围命令回归 |
| 暴露真实 DWS 健康状态 | 完成 | HTTP 回归 |
| 回归与打包检查 | 完成 | round-1.md |
| 合并后本地 Runtime 存活与真实入站验证 | 待部署 | 不将单元测试扩大为 DWS 业务 E2E |

## 重要决策

- 不以关键词或业务消息内容决定恢复范围；恢复按订阅群和 DWS 完整范围读取进行。
- listener 存活与补拉成功是独立信号；任一不满足时 DWS 入站不得报告健康。
- DWS 的 `--page-all` 默认不限制总条数；不能再以 500 条人为上限截断完整范围回补。
- 未部署到当前 DSH Web 前，不将代码、测试或打包结果表述为本机 DWS 已恢复。
