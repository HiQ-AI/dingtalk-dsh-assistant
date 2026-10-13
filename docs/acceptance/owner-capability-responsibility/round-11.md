# Round 11：本地部署整轮上下文去重

- 用户明确要求本地部署；候选commit为13d64bcaf730c378851e13dbb56f5f0d1883d73c，PR 168仍OPEN。
- 部署包SHA256：a304c582f21c2c50cdc215ea1c0f2f7be6c792e4bc4e35cc59fc6521f9f75c3d。
- 初始3080/18998无监听、无DSH进程；计划任务上次退出码1。旧启动日志记录Reached heap limit Allocation failed - JavaScript heap out of memory。
- 正式持久launcher restart-web.ps1 -Check通过（维护inactive），随后启动旧实例41000，health=ok、recoveryIssueCount=0。未修改内存配置，不将一次恢复等同OOM根因消除。
- 正式maintenance进入draining，阻止新领取并等待原Owner收口；不强停、不改控制库。
- 当前待完成：零写部署Check、安装、Readback、Resume及独立版本/进程/健康回读。
- 原Owner持续运行未自然排空；核对正式控制协议后，按部署需要临时pause原Task（controlRevision 1→2），Host取消并收口该会话，独立回读maintenance.drained=true、busy全0。安装核验后必须恢复同一Task，不新建任务。

## 安装与恢复回读

- 零写Check通过；安装包128文件核验成功，独立installed.json回读SHA256为a304c582f21c2c50cdc215ea1c0f2f7be6c792e4bc4e35cc59fc6521f9f75c3d。
- 新进程42884独占3080/18998，health=ok、recoveryIssueCount=0、inboundProcessing=true。
- 原Task通过正式resume controlRevision2→3恢复active；同一Owner身份不变。部署Resume返回ready=true/dispatchResumed=true，独立maintenance回读revision767、active=false。
- 原生日志baseSeq24190保留3494字符基础信息，turnSeq24195有contextBaseDigest。恢复首轮16923字符，其中events15556字符；这是积压事件，不是静态样本，不能宣称现场每轮只有2102字符。
- 运行时证据在docs/tmp/owner-context-round11-deploy-20261013及原生session.jsonl，未发送人工测试群消息。
- 现场功能实证：seq24602/25023的pwsh、seq24646/25056的job_output结果均直接附单独evidenceRef块；baseSeq24190之后新增独立回执通知0条。原Owner revision42/lease18 running、last_failure=null。
