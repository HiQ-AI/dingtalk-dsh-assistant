# 最终边界回归

所有测试进程均使用短 D 盘 TEMP/TMP；没有更改 Git/Node 产品封装。长 cwd 的最小复现显示：目录存在且长度 268 时 Git 启动 ENOENT、随后管道 ENOTCONN；短目录同程序 exit 0。

| 验证 | 结果 | 证明范围 |
| --- | --- | --- |
| 服务全文件第二轮 | 309 项，305 PASS / 4 FAIL | 本轮旧语义夹具修正后，仅剩 round-5 已独立复现的四项基线失败 |
| 工程全文件 | 29/29 PASS | 工程准备、工作区、交付证明及已承接授权接线 |
| 最终协调器与原生会话 | 51/51 PASS | 严格澄清、字段反馈、历史来源校验、材料暂态原请求恢复及权限故障不问用户 |
| 最终服务准入与参数用例 | 13/13 PASS | 明确交办、来源继承、批准/拒绝/过期、同 Task 补 UAT/仓库、生产审批隔离 |
| Web 客户端构建 | exit 0 | 当前 Observer 源码构建通过 |
| goal 结构和 diff 检查 | PASS | 单一检查点及无空白错误 |

最终服务定向命令：

```powershell
$env:TEMP='D:/codex/docs/tmp/clarification'
$env:TMP=$env:TEMP
node --test --test-name-pattern='任务准入|任务承接|工程环境由来源|开发缺UAT|非owner获批|旧授权过期|明确开发缺|明确指向其他|同发送人精确引用|群职责允许明确|模型要求为非本人|开发目标缺失|UAT补充' test/workflow-service.test.js
node --test test/message-coordinator.test.js test/group-coordinator-session-native.test.js
node --test test/workflow-engineering.test.js
node scripts/build-web-client.mjs
```

本轮独立审阅新增并关闭四个实质反例：修订需求丢失 ownerConfirmed；首条过期授权遮蔽新授权；合法 legacy 来源缺持久消息行导致澄清被拒；材料暂态错误丢 cause 导致无法退避恢复。授权保存仍只代表原 Task 承接，新增外部阶段被独立拒绝。明确指向其他同事的输入静默收口，不产生授权通知。

原始本地日志：`docs/tmp/clarification-service-tests/` 中 `service-round-2.log`、`engineering-final.log`、`coordinator-final.log`、`service-targeted-final.log`。此轮不把完整服务文件宣称为全绿，不把隔离语义回放宣称为真实群送达。
