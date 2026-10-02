# 纯审批观察阻止部署的受控切换

本次部署预检实际拒绝：旧实例 maintenance.busy.effects=1，其余节点、Owner、消息均为0。唯一效果是旧v5原生approval-gate的unknown；其逻辑只读取审批，但新handoff入口尚未安装，产生切换前置环。原工单未执行不等于可以直接删账或忽略unknown。

复用现有离线对账部署框架的顺序：check零写→进入active/draining禁派发→配置CAS见证Resident完整dispose→owner独占锁→停精确PID→完整备份及闭包校验→释放外部锁→原生Store自行独占，绑定manifest再只读核对同SQL/目标/工单/生产基线、Task NOT_STARTED无TaskRun→closeReadonlyApproval原生失败观察→busy清零后seal→精确包安装→恢复原配置→新进程回读→resume。

原recover-pr371工具固定事故ID、路径和多种其它领域修复，无法承载当前通用数据变更交接，因此新建两个单用途参数化脚本：PowerShell负责部署阶段，Node负责领域只读证明及原生观察。共享原有部署函数、备份和平台验证，不新增持久schema、调度器或生产DDL入口。

拒绝两条替代路径：在线热替换绕过冻结定义及关闭证明；放宽全局unknown排空门禁会放行真实未知生产写。离线只关闭唯一审批读取，不停止业务Run、修改需求、创建新工单或批准SQL。切换后由正式context/handoff入口接续同Task。

验收包括check零写、manifest漂移和其它未知效果拒绝、完整备份、原生观察收据、原运行身份保持、新包/配置/进程/维护回读及真实插件待审。脚本中断后只从持久阶段证据读回，不重复执行未知操作。
