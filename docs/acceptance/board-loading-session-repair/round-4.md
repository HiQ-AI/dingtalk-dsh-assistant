# 第四轮：原生查询证据集合闭环

第三轮真实调查揭示只核验引用集合可漏掉所有实际查询。新调查 v8 从当前原生会话 tool/call 和 tool/result（按来源事件及 callId）重建成功查询 evidenceRef；排空后从原生持久事件重建。completed 每项须引用或 coverageExclusions 给具体排除理由，所有引用及排除先核验任务、scope 和输出摘要；未排除查询完成分页及截断文件补读。没有新增持久表、索引或第二执行引擎。

旧 v5/v6/v7 原文从已安装 tgz 独立提取，与保留 builder 摘要逐项相等（3/3），避免改变已完成阶段。Owner 提示在业务等待前审阅必要授权资料代码，缺失证据不能由旧摘要代替。

实跑：新增原生 Loop/Tools/JSONL + 真实查询工件用例 1 PASS，首次只引用 dws-source 拒绝，当前会话补 Host evidenceRef 后唯一接纳，落盘重建集合与 live 一致。查询与调查合同 31 PASS；服务扩展 39 PASS（含 v6、v7 冻结计划升级）；Owner 原生会话 14 PASS。D 盘当前进程 TEMP/TMP，未修改系统环境变量。

第二轮精确包 SHA256 e6d41ea8e2db04fd8d2cdfb2b3218ffd6f19c7783cdf5b0e1ebae81792c08f84，部署 Check 零写通过。正式安装及原任务真实调查待独立回读。

## 正式部署及真实原Task

第二轮备份 D:/dsh_home/backups/owner-repair-20261002-094838-714，Assistant100文件摘要一致，Observer4文件保持；profile零写，摘要 e026ce9c9f7447968a6a2c8c7b13486d96134031e1b6d07f6f96e877e6f87e6f。新PID32460，ready=true、recoveryIssueCount=0、维护解除与dispatchResumed=true独立回读。

原Task经原生重评event206保留Task及Owner身份、两旧阶段和原产物，新增stage-3（Run6066c862…）。真实产物ab13d754…包含15条成功查询证据并明确排除全库其他表页；6条数据库查询逐项transactionReadOnly/productionReplicaVerified=true。授权项目地图完整读取，固定dataset快照搜索6页从0连续到1153、nextOffset=null，无截断遗漏。目录与代码不能确定name的用途/规格。Owner已应用wait、failureCount=0、lastFailure=null，水位207处理完成；真实headless Edge页面显示业务缺失、责任方与恢复条件。

真实群完整时窗回读complete=true、failedCount=0：最新等待消息1条，旧等待说明撤回后0条，本轮“任务已开始处理”0条。使用同组织当前profile；没有手工伪造群来源或发送新开始消息。生产DDL、审批和备份执行属于后续精确授权，本轮未执行。

独立环境边界：DWS实时订阅返回cooldown，最早北京时间10:04:25重试；实时接入health=degraded，历史读取/回填及发送回读可用。Task合法等待与订阅健康不是同一事实。当前不宣称实时渠道健康，待冷却后独立核对。

冷却后独立回读（北京时间2026-10-02 10:05:21）：health=ok、inboundProcessing=true，两群listener=ready/backfill=ok/lastError=null，humanReplies=ready。原Task Owner仍idle/wait、failureCount=0、lastFailure=null，水位207已处理。实时渠道健康已恢复，不需清空订阅保护或绕过冷却。
