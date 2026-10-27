# 团队统一产物与沙箱绑定

## 最新约束
用户明确团队统一任务产物目录，所有业务产物只能在该正式根内；覆盖此前分散Task目录fixture决策。不得通过新链或各自session.cwd绕过实现。保持shell/nativeFS同一精确写边界、目录外写拒绝，保持历史任务/会话/来源/完成事实。

## 已读实现
session-workspaces.js的taskFilePath受信logicalTaskId解析tasks/<logicalTaskId>/{materials,work,tmp,outputs}；taskDirectories.outputs是现有正式产物区域。taskWorkspace当前返回整个Task根，未承载协调域跨Task共同产物身份。task-session持久日志核immutablecwd，不可直接迁移旧session.header.cwd。
原生sandbox-policy默认从session.header.cwd取workspaceRoot，FS与shell都消费resolve的相同策略。只补ACL不会使FS越界目标合法；不能给消息中的任意路径添加系统写根。

## 实现方向与验证
1. 从正式Team/协调身份解析唯一artifact owner与taskFilePath的outputs根；不能用消息路径/标题选根。优先复用现有任务目录解析；只有无对应职责才新增小模块。
2. 通过Cordis原生作用域服务组合使Owner和执行成员读取同一精确产物写根；委托原policy模式/审批，保留原session header和日志，不改共享service对象或全局profile。
3. Windows只为该真实owned产物根准备必要WRITE_OWNER/WRITE_DAC，保留deny/owner/label与其他权限；前置Check，外部拒绝必须显式反馈。
4. 真实原生FS和shell都验证根内生成/读取成功、根外写失败；同团队A/B/C根相同，异团队根隔离，绝对路径/junction逃逸拒绝。
5. 优先原三Task经受支持恢复入口续办；路径纠正须沿正式业务来源/版本处理，不直接改SQLite或任务完成。证据链仍为原消息、依赖、正式completion事件、后继trigger及实际文件消费。

## 本轮已执行动作盘点
截至本方案落盘：未创建新链、未恢复原A、未手工启B/C、未生成a/b/c或分散业务产物。已执行仅三原Task根WO修复、summary受控部署（新PID94952）、文档/测试/证据文件。旧链与失败记录保留，不删除。

## 周期现有 Task 的固定产物范围

周期安排只可复用已冻结的现有 Task 指令，不支持周期创建新 Task。产物 owner 始终为 coordination ID，正式目录始终由 Host 推导为 `tasks/<coordinationId>/outputs`；slot/occurrence 不得生成新产物 root。

解析时校验 schedule 的当前及历史冻结模板、稳定的逻辑 Task 集合，以及每个 slot 的模板、occurrence、命令和原授权来源引用。重复轮次按合法模板归并，非法模板/新建命令/目标集合变化仍以 `TASK_ARTIFACT_RECURRING_SCOPE_UNSUPPORTED` 拒绝；跨 coordination 多归属继续拒绝。原生不可变 binding、已绑定后缺失 scope、任意路径和 danger 升权拒绝保持不变。

首次绑定可将原现有 Task 的写入范围收窄到该固定目录；不迁移 cwd、不覆盖旧 binding、不改 ACL。已有不兼容 binding 必须明确失败，不能退回原默认权限。周期恢复及委派执行沿用同一范围；文件已写入不代表任务已验收完成。
