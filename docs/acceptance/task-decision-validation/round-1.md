# 第 1 轮验证

## 基线

本地 main e961e51 已包含 #92。现场 Task 为 running/inputVersion 4/runSequence 3，已发送输入版本 4、已确认版本 3；plan 报告 input-wait。Topic revision 6/processedRevision 4，旧失败决策引用不存在的 stageId，反复出现 task_revision_stage_invalid。叶子最后 turn/end=blocked，Goal reason=task-coordination-pending。实际存储的 44 个 Task 阶段数组未发现空白或重复标题。

## 测试证据

- `pnpm test`：405 tests、405 pass、0 fail、0 skipped。
- `test/runtime.test.js` 覆盖无 stagePlan 旧 Task 的主叶阶段 ID 一致、同请求从拒绝到纠正、plan 审阅后 stage-completed 推进；持久坏决策重启退回后旧报告 history-only，新版本计划重新通过审阅，原 Task/Session 保持。
- `test/topic-store.test.js` 覆盖 Topic/Web 原子拒绝、normalize 后重复标题拒绝、创建/重开输入校验、队列最新版本和阶段复核、拒绝落盘失败保持旧预约、已应用/含取消/版本变化不可退回。
- `test/topic-runtime.test.js` 覆盖同 revision 退回后换请求身份、两次重启身份一致、共享消息原 effectOwner 不变、已发 Outbox 保留、恢复不重复应用。
- `test/http.test.js` 覆盖 rejected 不冒充正在执行意图，未处理 Topic revision 仍保留。

## 独立审查

审查发现的两个风险已修复：Store 与 Runtime 参数规范化不一致；创建/重开未验证重复阶段却在读取时强制生成 ID。含取消的历史决策另有先执行后落盘窗口，已从自动退回范围明确排除。

## 本地部署

待执行。只安装 Assistant 当前提交；保留 DSH、Observer、profile patch 和实际 v7 数据，不发送合成消息到业务群。
