# 第十三轮：已结束问答的状态显示

- 用户要求：按现有信息回答无法确认后，问答事项结束，不额外增加同事补证或确认环节。
- 只读核对本地控制库：目标业务任务及唯一阶段均 succeeded，没有 task_owners 记录；产物保留无法确认及缺少记录的说明。不是模型正在等待信息。
- 根因：workflow-service.js 的 tasks() 把有计划的 succeeded 一律映射 waiting，仅接受 Owner complete；无 Owner 的已完成计划因而误显示等待。
- 修复：无 Owner 且计划持久终态为 succeeded 时投影 completed/succeeded；不改任务、计划、产物和通知，不以结果文案判断状态。有 Owner 时仍要求当前版本验收及事件处理完成。
- 修复前新增用例实跑失败：实际 waiting，预期 completed。修复后同用例及真实确认等待反例通过。
- 首次整文件测试 73/74：既有双任务用例读取 runId 时失败；随后该用例与三个关联用例 4/4 通过，整文件重跑 74/74 通过。保留首次失败日志，不把偶发失败隐藏。
- node scripts/build-web-client.mjs 实跑通过；没有前端源码变化。
- 本轮未发送钉钉消息、未重跑目标任务。在线检查发现 3080/18998 未监听，计划任务上次结果为 1，日志 STORE_UNAVAILABLE；这是修复前已存在的实例启动问题，未做在线完成状态声明。

用例 C23 状态见 matrix.csv；日志位于 round-13/。

本地安装回读：Assistant 包为 docs/tmp/task-state-ee72278/zzusp-dingtalk-dsh-assistant-0.5.15.tgz，SHA256 为 3F32878719B40E52DD0B3AE742BC93F86BA8EF0A31A7E295B915F1F33B88A604；workflow-service.js 安装与源码均为 EEC679EACF16D974130D5524CA972E51E44E743E0943F410F35B0BF97C7071B9。profile patch 未变，Observer 依赖仍为前轮包。备份位于 D:/dsh_home/backups/task-state-ee72278，包含 profile、控制库及存储。只读存储预检 ok=true、invalidRecords=0、strippedFields=0。保留安装前停机状态；未声称在线生效。

## 用户要求部署后的在线回读

2026-09-26 13:31（北京时间）：按既有 DSH Web Local 计划任务启动，无须重新安装已核验的同一包。新 PID 34688 监听 3080/18998；83 个 Assistant/Observer JS/YML 文件与源码 SHA256 一致。health=ok、inboundProcessing=true、recoveryIssueCount=0；DWS listener ready、backfill ok，认证 Web HTTP 200。目标 Task 在线 state=completed、outcome=succeeded、waitingReason=null；全部 73 个任务为 completed。未修改业务任务记录或主动重跑/补发。此前 STORE_UNAVAILABLE 本次未复现，历史根因尚未定位；不把重启成功当作该异常的根因修复。
