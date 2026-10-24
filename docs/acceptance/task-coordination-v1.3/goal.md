# 真实群 A→B→C 总目标

在 DSH端到端测试-20260927 中，通过一次真实渠道入站请求，自动创建并严格依赖执行三个独立任务；证明 A→B→C 的完成触发、产物消费及最终群通知。历史 final-matrix.json 是程序合同，不代表本轮真实验证。

## 唯一 sub goal matrix
| Sub goal | Owner | State | Evidence |
| --- | --- | --- | --- |
| 确认最新改版及安装身份 | lead + contract-worker | 完成 | PR247 MERGED；安装9f41510=main5a1ab91+1，PR256 OPEN；PID73984；health ok/real |
| 一次真实请求及三任务依赖 | lead | 完成 | round-7.md：客户端单条消息自动创建三Task，依赖正确 |
| 执行先后及真实产物传递 | lead + evidence-worker | A沙箱权限阻断 | round-7.md：A启动前grantWrite失败，B/C保持hold |
| 群通知独立回读及收口 | lead | 未完成 | round-7.md：操作人求助单聊已送达，尚无最终产物通知 |

## 关键决定
- 2026-10-24：保留已部署9f41510，不重装、不降级；外部部署完成证据已核验并由监管明确交还。
- 基于现包9f41510创建隔离 worktree-coordinator-sequential-validation；不改主检出代码或用户资料。
- 两名实际原生 sequence-worker，effort low，分别契约/独立证据审查；lead保持high，独占部署外发。监管shared-tasks唯一入口仍在主检出指定目录。
- 本轮只新建验收记录/轻量文件，不写生产、不清历史、不手工启动B/C。默认DWS AI标签会被同助手回声门禁抑制，公开ai-tag=false用于代理测试尝试；真实群已可见，但插件入站未成立，不声称人工键入或E2E通过。
- 如失败，保留本轮FAIL，修复后新增round，不覆盖失败；全绿前不写report.md。

## 进展
Sub goal round 1：身份与设计就绪，下一步发送一次ABC请求；历史四轮记录保持原样。

Sub goal round 2：round-5 FAIL、round-6 BLOCKED。两个DWS代理发送均被平台标记DWS，插件按自身回声正常忽略。最小外部输入是用户用钉钉客户端在指定群把round-6冻结全文作为一条新消息发送；任务不需要用户逐个启动。等待此输入期间只读设计/证据已交付，不改回声保护、不再试发。

Sub goal round 3：21:07:41客户端消息已接纳并自动创建三Task，原入站阻塞解除。消息至A Owner认领70.255s；A因Windows沙箱grantWrite错误在37.385s后提交blocked，无正式complete，不能测A→B/B→C切换。当前继续方向是限定诊断沙箱权限/前置耗时，未获授权修改ACL或无关配置。
