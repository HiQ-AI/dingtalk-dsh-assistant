# 工程准备未生效候选恢复

## 修复与本地验证

沿原 reassess-readonly 和 Owner discard 恢复，不增新接口、不按Git128自动重试。共享只读资格同时在恢复事务与候选废弃处核验：当前blocked工程initialize、计划版本0、相同租约/需求/控制/授权/输入围栏、来源条件有效，全Task零阶段/Run/效果/计划收据与计划事件。只有此分支不依赖当前查询成功事件，其他重评保持原条件。

- `node --test --test-name-pattern='工程准备未落计划' test/execution-store.test.js`：14/14 PASS，5433 ms。覆盖无查询证据正例与幂等、receipt、stage、run、未排空、来源/租约/需求/权限/围栏/控制漂移和外部workflow拒绝。
- `node --test test/task-owner-store.test.js`：38/38 PASS，338 ms。
- 新predicate对现场只读控制库：eligible=true，planKind=initialize，workflows=[task-engineering]。

## 包与部署

包 `engineering-preplan-20261008-assistant-229c3d2e.tgz`，SHA256 `229c3d2e13cc58d92fec7346d116ae86e8200ececf9aa27680c511f99551fd4b`，100文件与源码一致。部署零写Check exit0；安装、新进程与恢复结果待独立核验。

## 现场恢复通过

包/源码/安装100文件一致；新PID36784，health=ok，inboundProcessing=true，recoveryIssueCount=0，maintenance已Resume。原Task来源、需求版本2、UAT2与原Owner session保持。

受管重评返回event316并废弃原未生效候选；随后独立 GET Task detail：state=running，Owner lease5/revision19、lastFailure=null，plan.version=1且requirementCurrent=true，stage-1 running，Run为`run-8fd2d5775eca1d446eb3fd72f2f881db5132b52326ebcaa06d949d585e37283c`。因此本轮不仅是重评accepted，已真实进入原Task工程阶段。

本轮目标为插件修复与任务发起；数据集功能实现、PR、测试提测和业务验收仍由该业务Task继续，不能以此记录宣称完成。
