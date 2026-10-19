# 第二轮：本地部署与真实浏览器

候选源码提交 33c8030；Assistant 2.0.0 SHA256 19e33f20ef505cd35a940aaac70299bb3ef4f37d54d135fb2f838f7104b1a139；Observer 2.0.0 SHA256 62e4598b61ed2fb3b335a693c1e2418b75a8df9dce2ed948929dadbb2130f888。

原生部署脚本 -Check 返回 writes=0、signals=0、33 个会话核验通过、unknownOperations=0；正式 SIGINT 退出旧 PID 58284，离线确认回合排空、无子进程。安装内容校验 Assistant 54 文件、Observer 4 文件通过，新 PID 35384 同时持有 3080 和 18998。profile SHA256 保持 aa38870b121ee6aec20e7beb69f10ebe79af017a356b4fe9ca177ab916a588fc，计划任务重新启用，无历史备份。

健康回读 inboundProcessing=true、dwsBridge.healthy=true。原有 1 条未知通知告警保持，health=degraded，不宣称全部历史通知已核验。

Chrome 真实浏览器重新加载模块，原问题通知主状态已送达，正文下单列替代关系；发送时间列显示未记录及独立回读确认时间。已送达筛选和存在替代关系筛选都包含原通知；刷新后状态与关系保持，旧固定撤回提示不存在。768px 窄屏可见状态、发送时间及附加关系，表格沿既有横向滚动查看右列；宿主窄屏使用页面水平滚动，并非新增表格独立滚动。临时 viewport 已恢复。

只读对比部署前后 64 条通知的 ID、送达状态、投递 ID、回读时间、替代指针及撤回状态：changed=0；没有借修复批量改账或重发。

基线/修改后/窄屏截图及部署 readback、控制与包摘要留在本检出 docs/tmp/outbox-delivery-33c8030*，含业务正文，不提交到仓库。定向测试命令与结果见 round-1.md 的第二次执行，共 104 项通过。新发送时间的渠道来源、校验和持久投影通过定向测试验证；本轮未向真实群发送新测试通知。
