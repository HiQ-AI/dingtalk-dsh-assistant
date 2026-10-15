# Round 6：本地安装与原任务正式对账

用户明确要求先本地安装观察，不推送/开PR。本轮使用task-session-clean-start.md规定的deploy-task-session-native.ps1，静止检查与原生退出切换，不使用已退役workflow maintenance接口。

- Check：writes=0、signals=0；10个持久会话回合结束，2笔unknown保留。
- Assistant：源码687a970；包SHA256 `05572d77b0e35d2e799c580a5887ba32249869a5c513b208308b67842c463760`；安装版本1.0.0；53发布文件校验一致。
- Observer：复用当前已核验包，SHA256 `86e76e317c83f8ffdfdb600befe09c60868c5e0456a4fb3c3604054141839f10`；4发布文件一致。显式双包避免官方安装重新解析override后回退Observer。
- 原生SIGINT退出PID63180，独立看到旧PID消失、子进程0、SQLite旧owner进程已退出，原生日志全部结束。无历史副本备份。
- 新PID28820同时监听3080/18998；inboundProcessing及dwsBridge.healthy均true，自启Enabled=true；profile SHA256保持 `fc9b7dc5b8780093510ef53d1aaae69764aac7791d93ee89328b6a0138dd0c96`。
- 通过原人工申请正式reply入口告知安装事实，明确仅核验原操作、不重放编辑/改业务/提交/重复UAT部署。原统筹真实调用task_operation_reconcile：日志call seq2639/result seq2640。
- 独立SQLite只读回读原operation后缀15a62ff4：unknown→failed；errorCode=FS_NOT_OBSERVED、noEffect=true、proof.kind=native-file-precondition-failed；原调用错误seq1334、同轮结束seq1406；previousObservation.state=unknown保留。统筹随后真实读取proof及previousObservation，不靠API成功回执判断。
- 健康仍degraded，但recoveryIssueCount由4降至2，余项来自另一任务，未触碰其业务或未知操作。原任务最终状态继续核对，不能把对账通过等同业务完成。

详细本机部署控制证据位于本worktree的docs/tmp/native-file-precondition-install/；独立读回native-file-precondition-live-readback.json与native-file-precondition-current-state.json。包含现场身份的原始数据不提交。

最终独立回读（北京时间2026-10-15）：原任务status=completed、drained=true，waiting-reply请求数0；正式/state/tasks/<taskId>/detail另行读取并保留在docs/tmp/native-file-precondition-task-completed.json。故本轮证明原操作及原任务收口；业务页面/UAT证据仍由原任务既有证据负责，本部署未重新实施。
