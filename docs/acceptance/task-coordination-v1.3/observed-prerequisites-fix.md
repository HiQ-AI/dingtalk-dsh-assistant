# 只观察前置与协调临时会话 cwd 修复

基线 main `9409e1968f94ee1e1446ad1577bad974da559eb0`。原实现把所有依赖前项都建成可派发指令，因此无法无修改地表达“A任务处理完之后继续B任务”；本修复明确补足该缺口，不能用之前的四阶段完成表述替代此场景验证。

## 最终行为

- 新增严格 `task-observe` 提案（taskId、目标版本、runSequence），在协调域保存非派发观察项供后项依赖引用。不修改 A 的 Task、上下文、要求、runSequence，不生成 A 的 occurrence、Task命令、Owner wake或执行指令覆盖。
- A 已完成时回读当前 Task 与正式 Owner 完成回执，要求 requirement/control/context/runSequence 一致；有正式 receipt 但无全局 event 的情况有独立严格校验。仅 completed 状态、丢失正式回执、旧版本证明均不能放行。A 未完成时保存等待原因，事件后的恢复扫描或重启对账继续原身份。
- B 的任务命令仍冻结并待依赖放行：等待/暂停任务继续原 Owner session；已完成 B 不被 continue 擅自 reopen，要新工作须明确授权/目标。已有业务执行的 B 在首次接纳、append、部分澄清 resolve 时均先进入原 Owner 无破坏预评估，不取消旧执行，不追溯承诺严格顺序；后续执行入口仍检查门禁。
- 用户明确要求先给 A 增加实现工作时仍用原可派发 task-context/replan 等动作；不能用观察吞掉新需求。观察项支持逐项澄清关联，取消/暂停安排仅控制观察，不能取消原 A Task。仅此观察合同不支持作为周期 task-command 模板。
- 临时规划会话每次创建时读取 Agent 当前配置工作目录；移除固定 coordination 子目录。配置保存使用既有绝对路径/存在目录/空值默认规范化，活动会话不变，下次 plan 使用新值。
- Agent cwd 与任务持久根拆分：首次目录保存保留旧 taskWorkspaceDir；原 Task/执行/Session日志和权限边界不迁移，Host重开仍使用旧根。历史日志继续走原 sessionPersistence，cwd变化不重写历史存储根。

## 验证与审查

全部使用隔离数据库、脚本化原生模型及假通知，无真实模型、生产群数据或渠道外发。

- 新 `coordination-observed-native.test.js`：3项真实入口闭环，A已完成、A未完成重启后正式完成、B原先暂停；逐字原消息“A任务处理完之后继续B任务”，确认A完整Task/wake不变、B沿原session/runSequence继续。
- 新 `coordination-observed-prerequisites.test.js`：8项，正式证明/版本失效/重启，无正式回执拒放行，receipt-only事实，暂停/取消，不停已有B执行及Owner预评估，B已完成不擅自重开，append/resolve新增B同门禁。
- 新 `coordination-workspace-native.test.js`：真实配置保存→下一plan session.header.cwd注入，运行中不变，Host重开任务/日志旧根、空值默认及相对路径拒绝。
- 受影响9文件最终 **74 PASS / 0 FAIL / 0 SKIP**，含既有主动处理A、新建带依赖、指令覆盖、触发命令、变更、汇总与模型配置。日志 `/workspace/coordination-final-evidence/observed-affected-final.log`。
- 另受影响回归中的语言框架5项、原重排native1项、#236 provider恢复12项均通过。其间两条新测试误将未初始化contextRevision断言为数字0，已改为比较完整原A对象；复验13/13（观察8+语言5）通过，不放宽不修改A的合同。历史72、48、13组合有重叠，不相加。
- 独立审查发现并修复：首次触发不能被waiting_trigger拦截；receipt-only必须实际验证；取消/暂停不能放行；append/resolve与首次接纳共用初始化逻辑。最终只读复审通过。
- 固定合成语言fixture由16增至18，新增纯观察/明确处理A对照，未重新进行真实模型回放；此前4/16真实模型通过不代表此修复树已实测理解质量。测试映射297文件守恒，release/category不变。

## 部署边界

本修复继续使用 schema v2，不对已迁移 v2 的百部再次执行 v1→v2。部署仍须按运行实例正常排空及未知效果对账，保持当前coordination关闭，何时启用及独立模型配置由对应部署任务核对。已有观察记录后回退必须使用认识该合同的兼容修复版本并按需冻结，不能因旧包也写v2就推断能正确续办新观察项；不能降版本号或覆盖旧库。云端只提交新PR，不在此任务合并、部署、发版或操作生产。
