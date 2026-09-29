# 集成及恢复回归

Windows 11、Node.js 24.19.0、PowerShell 7。TEMP/TMP 指向 worktree 下 `docs/tmp/workflow-domain-tests`。

## 实跑

命令清单已封装为 `scripts/verify.ps1`，可用 `-Suite integration|contracts|stages|detail|owner` 分组复跑。

| 分组 | 结果 | 证据 |
| --- | --- | --- |
| integration（服务/恢复四文件） | 165/165，0 fail、0 skip | round-2/integration-final.log |
| contracts（合同/执行/入口十五文件） | 307/307，0 fail、0 skip | round-2/contracts-final.log |
| stages（阶段合同及真实重启） | 6/6 | round-2/stages-final.log |
| detail（新增清单详情断言） | 1/1 | round-2/detail-final.log |
| 验证脚本实际运行 stages | 6/6 | round-2/script-stages.log |

以上批次存在重复用例，不能相加宣称独立用例数量。测试中的远端、模型和外部投递使用隔离替身；正式 Host 重启、SQLite、产物存储和文件字节核验使用真实本地实现。

## 追加复审

发现多次 revise/extend 后累计验收项可超过 32，导致新调查无法准备。已交由入参实现者处理整批接纳前预检及底层数量限制，最终回归归 round-3；本轮不据此宣称全部完成。
