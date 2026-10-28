# Round 6：受信Owner绑定时纠正历史沙箱模式

外部Remote权限命令被TASK_SESSION_HOST_WRITER_REQUIRED正确拒绝；修复移动到既有bindTaskArtifactScope唯一Host写域：scope/目录与原生绑定身份核对完成后，仅历史danger-full-access追加原生workspace-write事件，保留read-only、artifactRoot、历史及审批策略。错误scope不写模式，不新增泛权限接口。

验证：scope单元19/19 PASS；原生5/5 PASS（包含原session持久化/重启、原生执行绑定、FS与shell边界正反例）。初次Windows ACL环境失败保留；使用短物理owned测试根、work与temp兄弟目录及现有ACL准备后完整通过，未删断言或修改业务目录权限。证据no-full-startup/mode-native-acl-rerun.log。

新增sandbox-policy直接依赖仅使用原生setSandboxMode函数。正式profile direct dependency及override固定artifact.2，原入口SHA225d0fbd…9019af及manifest953380b8…4880a已保存，安装后须独立比对，不能误装未补丁版本。

当前待现场验证：最终包安装、新PID/健康/policy摘要保持；原Task/session/需求和控制版本保持；新增workspace-write事件及原pending wakes被消费。未完成前不宣称v4已恢复，更不宣称UAT2已发布。
