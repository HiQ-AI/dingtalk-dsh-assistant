# 公共话题事实与环境短答恢复

## 根因与修复

原生协调会话 lease60 已读取原 Task，首次候选正确归入原话题，却因第三人公共 fact 被 Task 权限拒绝，最终另建事实话题。故排除“候选中没有原任务”的解释。Host 又只从当前原文提取完整 UAT 名称，合法短答虽被理解为 UAT2 仍无法更新目标。

公共事实现在只关联话题、无 Task 读取/修改或 Owner 事件；合法 revise 独立核权。短答使用完整原文、当前版本及同话题来源引用，最终确认人为 Task 合法操作者，上下文不授予权限。纯事实历史恢复保持原文、身份及审计，禁止带通知、Task 或效果重放。

## 本地实跑

- `node --test test/message-ledger.test.js`：132/132 PASS，41215 ms；包括真实 existing 绑定公共事实不唤醒 Owner、revise 增加输入围栏、事实重处理反例。
- `node --test test/group-coordinator-session-native.test.js test/message-coordinator.test.js`：71/71 PASS，38854 ms（包含新 schema 及 Host 同批来源传递）。
- 服务环境来源合同定向：7/7 PASS，4250 ms；四条问答同批更新唯一原 Task 为 UAT2，未知/旧版/截断/跨话题/显式冲突引用拒绝，无来源猜测不能补齐。
- 服务文档/工程准入/公共事实联合定向：10/10 PASS，5945 ms。与上组交集2例，不重复计数；合计服务15个唯一用例。
- 上轮文档资源155项、原生群/协调71项、消息账132项、服务15项合计373个相关唯一用例通过；本轮未运行全仓测试。四项既有服务基线失败未纳入修复范围。

## 部署候选

`public-topic-20261008-assistant-92877cbf.tgz`，SHA256 `92877cbfc330aaed088017ed4cd6f205228d0ebdc0b648d6d6f834559769bffc`；包/源码100文件一致，部署 Check exit0。现场恢复与任务状态待独立读回。

## 现场读回

新包安装与源码100文件一致，PID28988，健康ok，maintenance已Resume；部署前后原有Task/节点/Run独立保留。四条真实消息均为来源版本2，全部 settled/applied，前三条公共 fact 无 Task 身份；末条为原 Task 的 revise，`uatEnvironment=uat2`。原话题名称已更新为“数据集过程导入导出开发与UAT2测试”。

原Task `task-1edb9931ffe6ecd4efc0a3949376d66f` 的需求版本2工件 `sha256-1374a0881bf598c429d774389f5c51a3dec74d4a2df1a531b57f0e5973733008.json` 独立回读target为dataset/uat2，保存全部四条问答原文；authorization仍指向最后确认消息的原需求方，未改为维护操作者或第三人。未新建该业务的Task、未再发送补充请求。

维护期间首次重处理调用已登记版本2，但进入调度时返回RUNTIME_MAINTENANCE_ACTIVE；Resume后沿同一原runId幂等回查/接续，四条仍为版本2，没有增至版本3。已同步runbook，不用HTTP失败推断零写入。

Owner从wait变为advance后遇到Git exit128；只读复现为配置源目录不存在，尚未访问远端，非DWS或话题/UAT错误。正在按原配置恢复独立dataset源仓库并系统重评；本记录不把要求更新等同于业务开发完成。
