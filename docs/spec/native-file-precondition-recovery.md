# 原生文件拒绝与故障恢复

目标：文件变更在读取、版本、类型、大小、字面匹配等前置条件检查中被 Host 明确拒绝时，原执行会话保留错误并自行读取/纠正后继续；真正不确定的效果仍禁止重复派发。历史 unknown 通过精确调用、参数/结果摘要、原生日志结构化错误及已结束回合对账为 failed，保留原账，不推断业务成功。

现状：task-session-service.nativeOperation 将所有 isError 记为 unknown；Host FS_NOT_OBSERVED 等属于写入前拒绝。工具日志 data.error 保留错误码，但操作账只保留内容摘要，旧恢复只能识别网页读取及历史停止错误。

方案：复用 dynamic-filesystem-scope 的文件边界定义文件变更前置拒绝类别；仅 edit/write + 已知无提交语义码可终结 failed。保留 errorCode/noEffect，取消、FS_IO_ERROR、权限、沙箱、未知码保持 unknown。复用现有只读日志对账与事务校验，绑定日志错误码与原始结果。原会话不需重启或人工回复即可读取并以新调用纠正。

Provider反证：用户引用 bb152ce8 的终态发生于 2026-10-14 22:36:15（北京时间），旧账为 EXECUTION_PROVIDER_FAILED；当前源码及安装包已识别该 PI_AI_ERROR HTTP200 processing 错误为 transient。DSH默认5次请求重试仅包含EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT，不包含PI_AI_ERROR；插件另有3次持久恢复且受未知效果门禁约束。不能把旧失败历史显示视作本轮重试失败，不能对未知写入放宽重试。

验证：原生 Host 真实 edit/write 前置拒绝、读取后同会话编辑成功；stale/no-match/ambiguous等前置失败分类；IO/取消/伪造文字保持围栏；历史日志与事务对账反例；当前provider精确现场样本分类及持久恢复。
