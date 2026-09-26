# 构建与业务验收分离

## 当前问题

工程 verify-candidate 仅运行 Host checks；dataset 当前只有跳过测试的 Maven 打包。prepare-commit 复用或重跑相同检查，finalize 核对 PR，没有业务验收门禁。

## 修改

新工程定义 v10 保留 verify-candidate 作为“构建检查”，后置 business-acceptance“业务验收”，再进入 prepare-commit。旧 v1–v9 定义保持不变。历史节点名称显示构建检查，不补造历史业务验收。

Host 可配置 acceptanceChecks，每项固定 criterion、expected 和受管命令；执行于冻结候选副本，最后命令输出 JSON {actual: string}，实际值必须等于 Host 固定 expected，退出成功仅为必要条件。结果保留验收项、预期、实际、通过状态及执行证据。模型或消息不能配置命令、预期值或自报通过。未配置时等待 ENGINEERING_ACCEPTANCE_REQUIRED，失败或缺结构化结果时等待 ENGINEERING_ACCEPTANCE_FAILED；阻止后续提交。验收覆盖范围由 Host 配置负责，不声称任意任务全部语义均由通用回归覆盖。

业务验收绑定候选摘要、需求摘要与代次；准备提交前仅复用同进程可信验收票据，重启后重新实跑，不信任传入 JSON。交付证明额外核对业务验收节点，旧任务仅保持历史证明语义。检查失败复用控制器失败证据工件链路。界面分别显示构建结论和验收项的预期/实际/结果，缺配置和失败均使用直白等待原因。

## 边界

不修改活动项目配置，不从历史补丁推断真实业务测试已通过，不重放已完成任务。已有定义配置仍冻结；变更 Host 配置后应通过新的受管任务使用新定义，不能绕过原定义漂移保护。当前 dataset 缺少可运行的业务用例是明确限制，不用空命令或模型判断代替。
