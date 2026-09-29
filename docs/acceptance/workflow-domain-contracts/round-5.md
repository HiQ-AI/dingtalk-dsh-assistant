# 恢复与组合夹具修正后回归

第四轮两个失败均已查明并修正测试夹具，未放宽产品门禁。

- 恢复扫描模拟新增只读 `workflowDefinition`，不注册结果合同；恢复与 Owner 原生会话合跑 10/10，见 `round-5/recovery-owner.log`。
- 工程→合并→失败部署→重建用例的旧单项“保存并部署”改为工程保存与 UAT 部署两项，各引用对应产物；工程输入冻结保存标准，部署检查器只收到外部领域证据并检查重建回执。保留前缀不重跑、原失败 Run 不改写、部署与重建各一次，补充清单业务 accepted 与条目完整断言。
- 该组合修正前定向失败见 `round-5/sg7-owner-red.log`；修正后 1/1 见 `round-5/sg7-owner-green.log`。真实模型及 UAT 均未调用。

汇总命令：`pwsh -NoProfile -File docs/acceptance/workflow-domain-contracts/scripts/verify.ps1 -Suite all`。

24 文件，555/555 PASS、0 FAIL、0 SKIP，301149.5856 ms，退出码 0；完整输出见 `round-5/final.log`。相比第四轮新增 Host 输入身份防覆盖与跨项引用反例。

本轮通过后仍发现原集合未覆盖的多工程阶段边界：领域内条目被全部交给每个工程阶段，可能误拒各自只承担部分验收的有效组合。该问题单独在第六轮记录反例，并在第七轮修复后重新汇总；本轮结果不代替该边界验证。
