# 第二轮：正式部署与原任务恢复

- 备份定向测试：`node --test test/deployment-integrity.test.js`，33通过、0失败。明确清理历史以原生Task/Run身份排除旧闭包根，完整SQLite和已有文件保留；未知归属、普通删除保留、当前任务存在及损坏文件继续拒绝。
- 数据库/配置/通知/看板定向回归73通过、0失败；新Task短名称及数据库目录服务集成1通过、0失败。
- 启动时发现新增专业提示改变冻结工作流摘要，修正为运行时context.databaseGuidance；独立读取当前Task冻结定义再生成，1个所需历史定义摘要匹配。
- 原版本恢复后重新执行完整维护部署；备份owner-repair-20261001-231918-173通过独立复核。新版启动问题在同一封存许可中恢复，修复只替换Assistant，保留已应用查询配置及Observer，原配置摘要与原备份、当前摘要与launch记录分别核对。
- 最终Assistant包SHA256：7306e915ec63d6bd1ecfefe72d2f1dcada54360619709f31e5c50414113122fb，100文件逐一核验。Observer包SHA256：f6a4cbe418841003dac0dd0b43aa8985bc4dfae00b7b948ea831f8b19c7e029c，安装内容独立核验。
- profile已应用摘要e026ce9c9f7447968a6a2c8c7b13486d96134031e1b6d07f6f96e877e6f87e6f。原始摘要及配置备份保留；只为生产Editor只读资源增加public结构授权。
- 原生Readback/Resume：ready=true、recoveryIssueCount=0、authenticatedWebStatus=200、dispatchResumed=true；任务数保持1。不将控制面就绪等同业务DDL完成。
- 两群协调会话cwd=D:/baibu-agent；permission preset=danger-full-access，approval policy=never，title对应完整群名。原会话文件两个SHA256与部署前一致，新会话带原生parentSession关系。
- 旧笼统受阻通知仅撤回本任务消息。撤回返回recallStatus=SUCCESS；独立完整群消息范围回读21:30–21:31:30返回count=0、complete=true、failedCount=0。按ID读取仍可返回历史正文，此接口不能用于证明客户端可见状态。
- 同Task readonly reassess接纳eventSeq=202，原Owner session保持，计划从1到2、调查attempt从1到2；未新建业务Task或重放旧Run。
- 新调查Run已实际生成agent-query-evidence：生产只读资源的tables及columns，public.process_id_temp当前仅id/character varying/NOT NULL，transactionReadOnly=true。证据摘要5ca6d47381eab2a6b26535672d930a839bb0b37bf321189c3ea60545bf71bdeb。
- 本轮调查阶段succeeded，Owner整理后续。新增name类型/长度/NULL/默认值及本次生产变更审批尚未核准，没有执行DDL。正式页面视觉与新消息模型延迟尚未复测。

原始证据保存在本地docs/tmp/task-feedback-deployment-round2-20261001、round3-20261001及docs/tmp/resident-session-runtime-20261001，含环境路径不提交。
