# 第 30 轮：验证与修复审查

日期：2026-09-27。用户要求审查上轮任务验证及修复，发现问题给具体修改方案。本轮没有实施产品修复，没有部署，没有远程合并或发送通知。

## 结论

两项指定业务场景的本地通过有真实证据；不能据此判断整个编排已稳定。具体 5 项 P1、5 项 P2 和证据管理问题见 `../../spec/development-uat-validation-review.md`。完整 UAT 链仍未完成，C33/C34 既有 FAIL 不改为 PASS。

## 本轮实际核验

| 用例 | 预期 | 当前结果 | 证据 |
| --- | --- | --- | --- |
| C36 | 原工程失败修复、预算续行保留验收及阶段门禁 | PASS，4/4 | round-30/recovery-tests.log |
| C37 | 两个真实本地验收候选原文件与冻结清单一致 | PASS，2657+997 文件，差异 0 | round-30/candidate-integrity.json |
| C38 | 最后预检后 UAT base 变化不写入未验收树 | FAIL，fake 平台先合并再报错 | round-30/uat-base-race.mjs、uat-base-race.json |
| C39 | 前端业务执行前准备失败具有可确认的零资源清理路径 | FAIL，缺 ledger 时两种清理均未知 | round-30/review-prestart-cleanup.mjs、review-prestart-cleanup.json |
| C40 | 非精确 1 的十进制结果不通过归一化断言 | FAIL，两个末位不同的值均 Number 转换为 1 | 下方 Node 最小反例 |
| C41 | 输入不变的确定性补丁失败不自动重跑 | FAIL，当前 service 测试确认 BASE_CONFLICT 会重跑 | test/workflow-service.test.js:25-40；recovery-tests.log |
| C42 | 待部署命令将配置摘要传给 profile CAS | FAIL，上轮传的是安装包摘要 | round-30/deploy-argument-readback.json；脚本:101 |

这里的 FAIL 是对产品预期行为的审查结论。复现脚本成功退出只说明成功复现缺陷，不能把对应产品用例记成 PASS。

### 恢复相关回归

PowerShell 中将 TEMP/TMP 设为当前工作区 `docs/tmp` 后，运行：

```powershell
& D:/soft/node-v24.19.0/node.exe --test --test-name-pattern='预算续行|service真实恢复入口仅跳过|正式Owner修复同Run新代' test/workflow-service.test.js test/execution-engineering-repair.test.js
```

实际 4 tests / 4 pass / 0 fail，150902.6473 ms。两条真实 Git/Owner 修复测试分别 82.1 秒和 68.5 秒；service/预算 HTTP 测试分别约 0.65 秒和 1.47 秒。运行于隔离测试目录，未重跑共享 UAT 业务场景。

### 零网络反例

```powershell
& D:/soft/node-v24.19.0/node.exe docs/acceptance/topic-context-completeness/round-30/uat-base-race.mjs
& D:/soft/node-v24.19.0/node.exe docs/acceptance/topic-context-completeness/round-30/review-prestart-cleanup.mjs
```

主代理独立再跑：前者 fake mergeCalls=1、模拟已写入，然后树校验报错；后者未启动浏览器/未读账号，cleanup 和 verify-cleanup 均返回 REVIEW_ACCEPTANCE_CLEANUP_UNCONFIRMED。两者 networkCalls=0。

数值断言最小反例：

```javascript
for (const raw of ['1','1.0','1.0000000000000001','0.99999999999999999']) {
  console.log({ raw, number: Number(raw), acceptedByCurrentCheck: Number(raw) === 1 })
}
```

四项实际均为 number=1 / acceptedByCurrentCheck=true。仅证明验收精度缺口，不声称实际业务库出现该误差。

## 静态审查与未覆盖边界

- 部署停机竞争、后台关闭运行时证明、构建后候选漂移、备份恢复和健康门禁为源码确认的缺口，本轮未在真实实例上注入故障。
- 候选清单重新核对无漂移；现有后台关闭代码并未被证实实际失效。不能把门禁缺口写成共享队列已遭错误消费。
- 目前后端 formal 检查仍为 skipTests package；22 项纯计算测试属于额外人工证据，后续应纳入正式流程。
- GitHub 文档现场核对：merge sha 参数约束 head，没有 expected base；只读回查 PR371/UAT3 与 PR368/main 均 OPEN。
- 当前任务 API 只读回查：后端等待 stage-2 确认，前端 EXECUTION_BUDGET_EXHAUSTED；两者未发生新的 UAT 操作。C盘 0，D盘约 1.04 GB。
- 源码、包、已安装实例三者区分：预算实现已写入包 db5b59c3…，仍未安装；本轮只增加审查方案及证据。

## 下一步

先按审查方案解决远端合入和部署屏障，再处理重复恢复、前端准备账、后台关闭证明及验证可信度。用户当前请求只要求方案，本轮不执行这些修改。原 SG15 总目标保留，不能写全绿报告。
