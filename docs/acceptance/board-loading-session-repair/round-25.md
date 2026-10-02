# 持续执行改造的部署恢复与真实验收

承接round-24首次r24包启动失败，原维护封存保持，业务操作未重跑。代码方案仍见docs/spec/continuous-task-execution.md；本轮记录修正后的独立复验，不覆盖首次失败。

## 修正及定向验证

- 从部署前正式r23包恢复external-result v4原reader/factory源码，Scoped v5承载当前验收作用域。当前登记、历史恢复、Host动态验收均显式按版本处理；selector遗漏v5的反例已补。release15/15、service13/13、contracts13/13通过，缺原始节点不能退回通用合同。
- 原生定义曾计入已移除的执行上限，利用现有legacyDigests保存旧身份；不恢复旧运行上限。核心Controller/Store/合同/领域整组126/126通过。
- 无备份部署的既有RepairStoppedLaunch现在可沿原封存许可替换精确Assistant包，不回滚数据、不新建历史副本；原控制历史/证据摘要/包与profile/进程排空/独占锁均核对。保留原Observer并验证，原自启须仍Disabled，Resume恢复原标记。无备份真实函数42/42、旧部署23组通过。
- 独立只读审查实际stage4/6：历史输入摘要/原批准/执行及回查证明通过，浏览历史不会调用生产；当前最终引用必达实时readCompletion。03:31生产只读副本独立确认表存在且name不存在。

## 正式部署与业务闭环

候选正式包r24c：SHA256 `061a5a7cd5f8c10dc91c661108d640f6c0b52aa34e59bed2693cc6d91d8eb89d`。真实停机现场Check进行中。安装、Readback、Resume、原Task最终验收和唯一群结果尚待回读。

私有证据位于docs/tmp/continuous-*.log/json/md及continuous-execution-r24c-deployment，不提交业务工件或凭据。状态以matrix.csv最新轮为准。
