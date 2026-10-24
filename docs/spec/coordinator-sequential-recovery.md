# 协调串行验收恢复方案

## 可验证目标
在不改变原三Task依赖、来源、要求与完成账本的前提下，排除原A的Windows沙箱启动阻断并修正摘要语义，原A正式完成后B/C由持久完成事件自动续行；独立核对nonce、原字节SHA、消费工具事件和最终群通知。

## 当前事实
安装Assistant/Observer2.1.0来源9f41510，PID73984；A Owner task-cfe4f8e8b0993c6458d8391f9e885516，原两次pwsh启动前SetNamedSecurityInfoW/Win325，未执行Test-Path，无operation/execution与产物；B/C仍coordinationHold。原完整源msgtrvT+6JRj5yJB5DDwxEAeQ==已被接纳。
摘要将task-command的succeeded接纳语义泛化为安排已执行，源coordination-summary154-165；不得改变提醒与只读查询的真实执行/通知语义。

## 修复路径
1. contract-worker核真实Host执行账号/token、目标任务目录ACL/owner和实际原生grant实现。基于反证确定最小根因，不关闭sandbox、不改整盘ACL；若ACL修复必要，只操作证据所指精确任务范围且先Check。
2. evidence-worker修摘要对task-command接纳与业务完成的区分，补阻塞/未完成/已完成及提醒/查询回归，更新行为文档。
3. lead审差异、实际跑针对性测试，冻结源码并打包；使用docs/ops/task-session-clean-start.md已初始化实例的deploy-task-session-native.ps1，而不是旧workflow maintenance脚本。先Check零信号/零写，再相同实参受控切换；保留当前Observer包、profile与宿主依赖；不建历史备份。
4. 原A human-request reply/check零写核验后，经同一路径正式reply恢复，不调用B/C启动/continue。再次核对两次失败工具的已知结果和未知effects，不能用恢复操作自动结算未知。
5. 捕获A/B/C completion.event/proof、后继business-event occurrence、job和Owner/执行时间，独立原始文件nonce/SHA与实际消费工具事件，DWS真实通知和摘要语义。

## 验证边界
相关测试、受控安装核验、真实业务E2E分层；无完成事件时不能猜切换延迟。延迟分消息→路由/协调接纳→A认领及每次完成→后继occurrence/job/Owner/执行。
若发生实际提权或审批拒绝，由Codex协调精确对象/最小动作；不把可独立修的事项变成笼统等待。分析和修复证据进入round8/matrix，后续重验新增轮次保留失败。
