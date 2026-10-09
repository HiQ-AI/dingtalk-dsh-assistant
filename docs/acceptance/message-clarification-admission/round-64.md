# Round 64：必要依赖候选仓库作用域

现场只读：SG22 Task requirementRevision=1、planRevision=1，target=dataset-web/uat3，原stage-1仍running且原Run未替换；必要dataset阶段尚未插入。

根因是正式Owner的insertDependency候选已带精确sourceCondition，但registry.prepareTask仍按原交办的唯一前端routingTerms拒绝backend。修复由StageContract仅在insertDependency时传候选stage/前置stage/计划版本；registry重新读取当前Task需求和计划，核配置dependencyRepositories、原作者/版本/原文及阶段验收、同UAT、候选objective、当前同Task等待排空Run。只有该候选优先于关键词；普通首次选仓保持冲突拒绝。不改v18业务工厂、控制库或业务仓库。

定向真实Git仓库＋StageContract→registry测试覆盖：显式backend准备成功；未提供insertDependency、错UAT、跨Task、旧sourceVersion均拒绝；既有单独来源断言覆盖无关仓库/他人/未配置依赖/空验收。首轮测试2/2 PASS（4809ms），随后扩大相关合同回归另记录。尚未部署，不宣称真实backend阶段已执行。

扩大回归 `node --test --test-name-pattern='必要|批准|工程阶段|重执行复用' test/workflow-engineering.test.js`：本次相关5例PASS；旧重执行分支用例在execution-workspace.js子进程管道创建处报Windows `read ENOTCONN`。单独重跑同例仍同错误（17.39秒），未将其冒称PASS或改业务逻辑绕过；该环境相关验证盲点需交付说明。源码语法与定向diff检查通过。
