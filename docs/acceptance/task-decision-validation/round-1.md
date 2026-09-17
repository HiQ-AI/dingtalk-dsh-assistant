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

- 固定源码 `7ec1a373f31b6e9bf7ec684133da4653fbeae80a`，包 SHA256 `230126F619B68AFFD604289A9E2199705D521140176F62EC35002CBC46CCC1D2`。唯一打包目录 `docs/tmp/task-decision-7ec1a37`，安装后所有 JS 摘要与源码相同。
- 备份在仓库外 `C:/Users/64554/.dsh/backups/task-decision-7ec1a37-20260911-1337`，存储文件 8,703,101 字节。停机后 v7 预检 45 Tasks，invalidRecords=0、strippedFields=0；启动写入新 rejected 状态后再次预检同样通过。
- Profile 仅 Assistant 依赖变化；DSH、Observer 和其它依赖未变。patch SHA256 `4A602C3FF29752F32C5F6599B47D86031220FAC7BD800AD71B782487A9A8B2C9`、settings SHA256 `EA141B86779C2C88208AF7B032BFB8AD0E53069E83B42693598042269C884BAF` 前后一致。
- 新 PID 587996 同时监听 3080/18998。health=ok、DWS listener=ready、backfill=ok、recoveryIssueCount=0。启动认证链接换取 Cookie 后，独立访问首页 HTTP 200，包含 __DSH_BOOT__；未认证请求 401。凭据未进入本记录。

## 现场恢复

以下时间为 UTC，均为新实例启动后的持久记录和 Session 工具结果独立回读，不手改生产 Store。

- 05:39:40：旧 revision 5 决策变为 rejected/error=task_revision_stage_invalid，保留原记录。
- 05:41:31：新 revision 6 决策 completed，唯一 Task 操作 applied；Topic revision/processedRevision=6/6，原 Task inputVersion 4→5、runSequence 仍为 3，原 Session 未更换。
- 旧计划 draft-log-modal-fix-plan-v4 进入 history-only，未冒充通过。05:42:03 叶子用真实 stageId 提交 v5 计划；05:42:26 审阅接受，05:42:27 报告 accepted；Task dispatchedInputVersion/acknowledgedInputVersion=5/5。
- 05:42:27 同一叶子 Goal 从 blocked 恢复 active；05:42:34 实际调用 pwsh 拉取 HiQ-AI/dataset-web 并创建 worktree-fix-log-modal，05:42:42 工具结果确认 worktree 建立，基线 e3dcee2d。这证明真正执行恢复，不只是状态标签变化。
- 两条原始增量消息 msg2nZhF3cOUixcuC35r2vzUQ==、msgggYp9bD9PiYgIPVAoOwOXA== 均 routed/delivered。新回复 Outbox=sent；未另行做收件人端可见性验收，不将内部 sent 当收件确认。
- PR #93 当前 OPEN：https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/93 。业务弹窗修复和 UAT2 交付由原任务继续，本轮不声称其已完成。
