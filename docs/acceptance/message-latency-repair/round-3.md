# 第 3 轮：冻结源码后的最终验证

Windows 11 / PowerShell 7，Node.js 24.19.0，仓库锁定的 DSH 0.2.1-alpha.2 原生测试 profile。测试使用临时库与受控模型，不连接真实钉钉，不操作当前业务任务。源码冻结后顺序执行：

```powershell
$unit=Get-Content docs/acceptance/message-latency-repair/round-2/unit-files.txt
node --test @unit
$env:DSH_NATIVE_TEST_PROFILE=(Resolve-Path test/fixtures/native-profile/package.json).Path
$native=Get-Content docs/acceptance/message-latency-repair/round-3/native-files.txt
node --test --test-concurrency=1 @native
pnpm test:release-smoke
node scripts/test-suites.mjs check
node --check docs/acceptance/message-latency-repair/scripts/audit-today.mjs
git diff --check
```

## 独立输出

| 文件 | 结果 | 实际证明 |
| --- | --- | --- |
| round-3/unit-tests.log | 469 PASS / 0 FAIL / 0 SKIP，16.716 秒 | 24 个风险相关文件；目录观察、严格合同、时间窗口、恢复、回复审阅与分页 |
| round-3/native-tests.log | 47 PASS / 0 FAIL / 0 SKIP，177.320 秒 | 11 个原生文件；实际入站/Host/SQLite/发信箱路径及持久恢复 |
| round-3/release-smoke.log | 14 PASS / 0 FAIL / 0 SKIP，26.448 秒 | 实际 tgz 执行任务、解压 Resident 启动健康、产物与测试映射 |
| round-3/suite-check.log | 299 文件各一次，3 个历史文件，0 删除 | 无遗漏/重复注册，不缩小 Release 边界 |

最终三组 **530 项通过**，重复轮次不累计。审计脚本语法与 diff 格式检查通过。

## 效果及反例

- 17 任务受控原生场景：协调模型 1 次调用直接提交，0 次 context_get、0 个完整任务详情。41 任务：2 次模型调用、补读 1 页目录。不扩大 8 步预算、不改变退避参数。
- 失败的上下文读取不会授予目录观察；未读目标、跨群、任务变更未读完整合同、条件续办未读完整合同仍拒绝。纯查询不修改原 Task 版本或重启 Owner。
- 消息原时刻、处理时刻分别提供。迟到 17 秒与 15 分钟边界沿用原时间；超窗明确过期，重启不改到次日、不重复产生实例和通知。原消息已过期或来源时间缺失仍拒绝。
- 重试等待中故障仍可见；成功澄清后清除原故障，但 attemptCount 保留；handoff 丢 ACK 路径也回收旧告警。通知不重复发送。
- 回复审阅规则与分页上限已投影到模型实际工具 schema，现有拒绝反例仍通过；未降低运行时校验要求。

实际模型是否一次正确提交及线上耗时下降比例未验证。打包/启动 smoke 不等同于本机部署和群内业务验证；本轮没有 CI、发布或部署。
