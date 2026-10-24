# 真实群 A→B→C 总目标

在 DSH端到端测试-20260927 中，通过一次真实渠道入站请求，自动创建并严格依赖执行三个独立任务；证明 A→B→C 的完成触发、产物消费及最终群通知。历史 final-matrix.json 是程序合同，不代表本轮真实验证。

## 唯一 sub goal matrix
| Sub goal | Owner | State | Evidence |
| --- | --- | --- | --- |
| 确认最新改版及安装身份 | lead + contract-worker | 完成 | PR247 MERGED；安装9f41510=main5a1ab91+1，PR256 OPEN；PID73984；health ok/real |
| 一次真实请求及三任务依赖 | lead | 完成 | round-7.md：客户端单条消息自动创建三Task，依赖正确 |
| 执行先后及真实产物传递 | lead + evidence-worker | 完成 | round-9.md：原三Task正式完成、同一团队根、真实nonce/SHA消费 |
| 群通知独立回读及收口 | lead | 完成业务验收，正在Git交付 | round-9.md：最终群mget完整/health ok；保留旧失败通知 |

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

## Sub goal round 4：授权修复与闭环
- 用户明确授权权限阻塞与误导文案必要修复、定向实跑、受控部署、原A受支持恢复和真实群重验，原只读限制被本轮授权替代。
- contract-worker(low)：身份/ACL/原生grant精确根因；evidence-worker(low)：summary代码/测试/文档及独立证据审查。lead(high)独占部署、外发、原A恢复，不直接启B/C。
- 当前已核A无operations、无executions、产物目录不存在，之前两条Test-Path都在沙箱启动前失败；恢复前再次核未知动作。
- 当前包仍9f41510/PID73984；PR256已合且最新main5ab3c46只有验收文档增量，保留全部现包功能；PR257改基main。
- 本轮验收新增round-8，不覆盖round-7真实失败。需证明A正式完成→B首次启动→B正式完成→C首次启动、nonce/SHA真实消费、最终群通知及修正摘要文义。

## 关键纠正：团队统一产物根
- 最新明确要求覆盖监管分散fixture决定：团队统一任务产物目录，不能在正式产物根外添加业务产物。上一轮Ask选项为Codex实施判断，非用户新增答复；不记作用户另行批准分散目录或扩展宿主能力。
- 停止分散目录/新链方案；未执行新链、A恢复、B/C手工启动或a/b/c业务写入。已执行ACL3根WO修复与summary部署，全部有记录。
- 增加sub goal：确定唯一受信团队/coordination产物身份和正式outputs根；修Owner/执行的shell/nativeFS一致精确边界；原链安全恢复与目录外写负例一起验收。

## Sub goal round 5：真实统一产物闭环完成
- 原A通过受支持human reply/check恢复，未改原Task identity/version/依赖/完成账；B/C自动释放，无人工启动。
- 唯一团队root：D:/baibu-agent/tasks/coordination-f1767af593d66d5eabe73d31dfbc9a30/outputs。A/B/C全部completed，正式事件sequence5/6/7，B/Cbusiness-event精准指向父完成event。
- 实际a.json/b.json/c.md与nonce/SHA链和native工具日志通过；最终群通知完整回读。切换claim耗时A→B5.298s、B→C3.600s；首次native工具到达分别16.603s/11.763s，不能把后者算coordination切换。
- 剩余：commit/PR交付证据、队友独立复核和最终发行烟测；全绿前不写report。

最终独立复核：contract-worker和evidence-worker均对原库/原生日志/实际文件/群消息直接回读确认真实E2E PASS。最终受影响隔离回归122PASS/0FAIL/0SKIP，发行烟测14PASS/0FAIL/0SKIP；新增4测试release=true/映射307文件守恒。无需再次部署或重做业务链；只完成提交/PR/共享表收口。
