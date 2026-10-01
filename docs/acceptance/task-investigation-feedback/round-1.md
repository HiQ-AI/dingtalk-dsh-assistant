# 第一轮修复与验证

## 修复

任务名称使用8–20字、最多30字的业务标题，存入既有requirement.title；完整objective保留。新建、旧任务要求固化、目标修订与读模型使用同一限制；看板关联任务补齐原有短标题显示函数。协调Prompt要求不以“针对某人要求”起头。

生产调查通过既有Host登记数据库连接。新增显式metadataSchemas仅开放schema中的表目录/列结构；数据select不扩大表列白名单。目录提供environment/connectionId/metadataSchemas/tables且不提供凭据。调查Prompt明确生产副本查询顺序及范围错误的处理。

受阻通知保留Owner的summary，归一化空白并最多160字符，沿用旧eventKey保持幂等。Owner Prompt要求说明具体受阻事项、已尝试方式和缺少依赖。

## 已执行证据

- `node --test test/agent-query-tools.test.js test/configure-agent-query-resources.test.js test/workflow-notification-obligations.test.js test/observer-client.test.js`：73项通过、0失败。
- 新增服务集成用例使用真实store/controller/service，验证短标题与完整目标分离、生产连接及元数据授权进入调查输入、不包含credentialsPath；测试夹具仅补充登记query_readonly_database，模型为受控响应。
- 原同任务汇总卡片与分页执行用例通过，修复不改变逻辑任务身份。
- 使用修改后的createAgentDatabaseReadCapability和createRegisteredPostgresConnector连接正式tianyi_editor_slave，读取public.process_id_temp的columns：返回id / character varying / nullable=NO；transactionReadOnly=true，原生verify=true。每次生产连接必须先验证pg_is_in_recovery=true才会返回结构。这是实际数据库结构查询，不是mock；没有读取业务数据或执行DDL。
- 待应用配置仅给现有生产Editor资源增加metadataSchemas=[public]。`configure-agent-query-resources.mjs --check`：changed=true、writes=0；原profile SHA256 da396f19748dd0a4ad103812a017ca5411e1cf827e36bb86378e90640116d4e8保持不变。
- 前端技能strict audit：0 errors、0 warnings；复用当前标题函数，无布局改变。源码VM验证覆盖长文本、关联任务入口、当前目标展开。未在正式页面验证新版本。

## 待部署边界

延续resident-session-runtime/round-1.md的历史4工件缺失阻塞。未停止正式服务、未应用profile或包，不宣称钉钉实发通知或已在线修复；新版本及metadataSchemas配置需要在恢复原工件后通过正式部署检查。
- 最终服务定向回归：6项通过、0失败，覆盖查询资源身份变化、新任务短名称、执行汇总、重开等边界。
- Owner原生会话定向回归：13项通过、0失败。Assistant/Observer安装包已生成并回读长度645992/36344字节，未安装。
