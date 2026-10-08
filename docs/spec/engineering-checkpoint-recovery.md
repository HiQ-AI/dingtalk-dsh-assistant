# 工程检查失败的最小续行边界

## 现场问题

Task task-83c651ebdbdb77584a06d1fcb6b9e255 同一Run已经从generation1推进至3。两次verify-candidate失败皆为dataset-build的固定测试路径不存在：安装依赖成功后node --test失败，yarn build尚未执行。两代apply-changes没有文件修改且tree相同。Owner把检查配置失败视作业务代码修复，通过input.accept/input.apply从第0节点启动，重复需求准备、本地验收规划、工作区和源码阅读。原始只读证据在docs/tmp/build-recovery-diagnosis.json与build-evidence-read.log。

## 约束与最小路径

不修改v18及更早冻结工厂的mapInput/execute/prompt/ownerContract源码；这些参与持久definition摘要。现有记录继续按真实installed工厂验证，不能以换digest绕过。无现场恢复或重启；正在执行的gen3保持运行。

1. 工程检查配置/输入缺失与真实断言失败分开。Host解码其自己写出的check日志，发现注册检查明确引用不存在文件时，视作待修正的检查前提，不进入自动业务repair-proposal。保留完整失败证据，不能跳过检查或把配置错误当任务代码错误。
2. 复用node.resume的身份、来源、control、requirement、lease、排空和问题去重门禁，为纯/read的verify-candidate提供明确同代重验准入；执行输入和候选保持原样，仅该失败节点重新领取lease，前置节点和其输出不变。Owner必须携带诊断与可核验证据，不因反复请求而重复同一失败。
3. 确有代码变更时才使用现有工程repair上下文；本轮不把input.apply简单改为suffix后宣称工作区已保留：代际变化还关联workspace/effect/candidate身份，必须另有明确候选增量修复合同才能复用。现阶段先阻止错误分类驱动的无效全流程重跑。
4. 缺材料不能成为no-change合格依据。来源材料传递与用户投影由并行service修改解决；旧冻结节点不靠关键词判断业务事实。新增准入必须依赖真实来源/材料状态，不能通过reason的中文措辞做过度意图判断。

## 文件边界与验证

Controller/store的节点恢复边界、task-workflow-contracts的工程检查分类、workflow-engineering的非冻结Host辅助入口及对应定向测试。保留service文件给并行负责人，不改worker Owner重评区域。回归验证覆盖：同代复验保留prefix/workspace/candidate；配置缺失不修业务代码；source/control/lease变化、未排空、已有下游效果拒绝；重复恢复幂等或明确要求策略改变；旧v18工厂摘要不变。

## 实施收窄：共享材料与检查配置

用户确认材料采用现有 Task 共享目录。正文继续只存 work/artifacts 的原 SHA JSON，共享索引列出来源版本与 current/history；工程读取工具按 Task 绑定按需读取。历史材料明确标注历史，不冒充最新授权。撤销材料全文 taskContext 复制与 materials checkpoint。新增材料只更新索引，不改变 generation 或冻结节点定义。

检查配置采用唯一内部 checks checkpoint：注册实际新检查配置生成的完整 workflow，保存 checkpointChecks 与原摘要/请求号；Controller 准备 verify-candidate 新输入，Store 对 Task 控制/来源、Run revision、旧新注册记录及排空状态做 CAS。只允许旧新记录除检查配置/审计字段外完全一致；当前 verify-candidate 必须为工程验证失败且后继完全未执行。保持原 Task/Run/generation、全部成功前缀、工作区与候选；仅更新该失败验证节点及后继的节点版本，不清除旧失败证据（审计 artifact 保存原输入/输出/证据引用）。不得直接改全局 profile 造成其他已注册 Run 摘要漂移。
