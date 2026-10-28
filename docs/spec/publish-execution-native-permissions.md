# 原发布成员原生权限恢复

## 目标与现场
用户明确要求修复原发布成员运行权限，继续原检出、原Git认证辅助程序及原UAT2集成，保留全部已有验证。真实失败为c5 input8：git add无法创建共享common-dir中的index.lock；git ls-remote认证sh的MSYS命名对象创建被受限token拒绝。原开发/集成资源已持有；只读对账证明未提交/推送/部署，不能归为缺业务批准或凭据失效。

## 根因与选型
artifact.2把统一产物归档根变成唯一业务文件边界，并禁止原生显式完整权限；因此代码与Git元数据永远无法正常写。只给outputs补ACL不解决；贯通多个可写根虽能解决Git目录，仍无法解决MSYS命名对象。复制检出/改认证辅助程序/让主进程代发布均违背原路径和身份。采用现有原生sandbox mode：由受信operator对精确原execution一次性记录权限纠正，原生Host在该execution的setup设置danger-full-access；不提升Owner或其他成员，不改profile，不用字符串过滤命令伪装安全沙箱。此原生模式对该发布会话采用当前Windows用户权限，业务操作仍受原Task授权/资源/目标约束；artifactRoot继续是唯一产物归档地址，不能拿归档规范强行替代业务操作权限。

## 实现边界
复用human-request技术答复/check入口，附executionPermissionCorrection {executionId, expectedInputVersion, mode, reason}，mode仅支持原生read-only/workspace-write/danger-full-access。必须operator请求、Task owner actor、精确Task版本、原执行归属/inputVersion且已排空、非Claude、无未知/在途效果；Check零写。source/requestIdentity持久保留纠正，ledger再次校验原子记到原execution，不改需求/控制版本、不创建执行或重放。重复请求保持幂等并拒绝内容漂移。执行Host从原ledger与受信source解析，忽略model提供的同名input字段；仅对应execution setup append原生mode，session cwd/artifact binding不改。

原生policy新patch版本只允许受信Host设置的standing mode以及原生批准的per-call mode，保留binding身份/路径不变；不再无条件把原生完整权限强制降级，默认workspace-write与read-only仍约束产物根。现有原生审批仍由原生工具负责。没有受信纠正不自动给当前发布执行提权。读取/排空/安装按现有runbook，不扫全库、不重跑已通过业务测试。

## 验证与交付
定向验证Check零写/actor版本归属拒绝/原执行权限记录及历史/同session同execution恢复；真实原生临时git检出与MSYS子进程验证恢复，不改凭据、不做业务提交来试权限。部署前准备精确双包及policy清单，静止后安装；恢复后正式答复当前human request，原Owner续办原c5，独立读回实际新输入与发布进展。软件验证、权限恢复、原业务部署分别报告。
