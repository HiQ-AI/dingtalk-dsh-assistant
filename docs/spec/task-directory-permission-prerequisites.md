# 任务目录权限源头准备与能力事实边界

## 用户目标
用户要求杜绝同类目录问题并明确放开目录权限。范围取当前已配置Agent工作区D:/baibu-agent中的tasks根及继承子目录，既有原生workspace边界保持；不把指令扩大为整个电脑或生产平台权限。

## 已证实根因与反证
原outputs与tasks根owner均为当前用户，原生诊断有效WRITE_DAC=true但WRITE_OWNER=false。Windows sandbox grantWrite同时设置DACL及Low标签，需要上述前置权限；原mkdir只继承普通Modify。官方诊断脚本已验证本次根授权，但其FullControl规则不带OI/CI，不能保障未来任务根。已有2000目录有界检查未见protected，队列仍有剩余，不能声称全树均继承。

最新Owner真实工具schema含task_delegate，无humanReview/dialogue/assessment限制，却没有尝试该调用而声称入口不存在；实际pwsh失败仅grantWrite。排除工具缺失、业务授权撤回、验证失败三种替代解释。

## 实施
新增一次性prepare-task-directories.ps1，只接操作员明确WorkspaceRoot并派生其tasks目录，不接任意目标Path。参数是本次操作员的授权根，不伪造脚本能判断任意路径是否业务授权；拒绝卷根、相对路径、reparse链及owner非当前用户。仅添加当前SID OI/CI FullControl，不改owner、deny、其他SID与继承保护标志，不递归手工覆盖子ACL。Check零写，Apply需原ACL哈希CAS及先备份后独立读回；重复调用幂等。权限不在每个任务/模型轮中自动修改。运行实际配置根后，新mkdir自然继承，protected/deny仍保留明确限制。

现有Owner提示同步真实能力边界：目录ACL错误不得升级为未尝试的delegate入口不可用；已有终态执行可沿同executionId、新稳定key进入剩余发布，不重放已有步骤。不新增通用审批、额外review Agent或强制所有wait重走判断协议。

## 验证
独立临时workspace Check零写；Apply及幂等；已有可继承子目录与后续mkdir孙目录继承；owner/deny/其他规则保留；绝对路径/卷根/reparse/owner/ACL竞争拒绝。实际tasks根在用户授权范围内准备，现有与新建探针目录独立回读；原生受限shell同目录成功与越界拒绝；沿原执行仅续办剩余授权阶段。原UAT交付事实与软件修复验证分开，不虚报业务完成。
