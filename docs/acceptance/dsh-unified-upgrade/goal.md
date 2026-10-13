# DSH Web 与插件统一升级

> 状态：ACTIVE
> Goal ID：dsh-unified-upgrade-20261013
> 最近维护：2026-10-13T21:39:31.3792174+08:00
> 权威目标：D:/codex/worktrees/dsh-unified-upgrade/dingtalk-dsh-assistant/docs/acceptance/dsh-unified-upgrade/goal.md

## 总目标
统一升级当前 Web profile 的 DSH、Codex Connect、钉钉 Assistant/Observer、Convergent 与 Bytebase，保持业务数据、历史任务、模型/搜索与 OAuth 设置，并完成正式实例部署核验。

## 完成条件
- 所有目标插件在同一精确宿主版本上通过相关原生回归及隔离启动，不使用 allow-version 豁免。
- 正式 profile 安装版本与包摘要正确；同一新 PID 持有 3080/18998，健康与 Bridge 正常、恢复问题零，维护退出，延迟存活。
- 旧业务控制账与任务身份保持，历史会话迁移有实际只读/隔离证据，认证 Web 和插件加载核验。

## 范围与约束
- 用户 2026-10-13 已授权统一适配/升级，Bytebase 一起升级。已卸载插件市场，禁止恢复。
- 保留主仓及其它仓用户文件。工作区中文，PowerShell 7，Node24，先读再改。正式停机前先自检及维护排空。
- 复用今天已合并的钉钉宿主适配与校验通过的 alpha2-suite，先审计其来源及包，再决定精确目标。
- 无真实模型/钉钉外部发送验收时明确边界；不伪造或重跑业务任务。

## sub goal matrix
| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | 当前版本与来源校准 | profile 状态、最新发布、suite SHA256 回读 | 完成 | round-1.md |
| SG2 | 钉钉/Connect/Convergent 适配验证 | 目标依赖、相关回归、来源与包校验 | 完成 | round-1.md、round-3.md |
| SG3 | Bytebase 适配 | 构建、类型、测试、包与兼容声明通过 | 完成 | round-1.md |
| SG4 | 隔离完整实例与历史恢复 | 同正式原生策略完整依赖、所有插件启动、历史读写恢复通过 | 完成 | 原生策略冷装、UI及历史PASS |
| SG5 | 受控正式部署 | 自检、排空、封存、新实例及旧业务回读通过 | 完成 | round-7.md |
| SG6 | 源码交付与验收归档 | 必要源码提交/PR 回读、矩阵与报告 | 进行中 | Bytebase PR3 OPEN；根仓交付中 |

## 当前检查点
- 当前子目标：SG6
- 唯一下一步：核对当前diff与定向实跑证据，提交中文PR并独立回读，完成矩阵、最终报告和目标状态。
- 未闭环项：源码PR/验收归档。正式维护已inactive rev773，PID39344、双端口、health/Bridge/inbound正常、recovery0；并行配置原prefix不可恢复盲点及真实业务E2E边界已记录。

## 进展
- 2026-10-13：正式 DSH 0.1.2-rc.1、Connect4.42，PID46964；插件市场未在依赖中。主分支最新 b2fb1ac 含 alpha2 原生会话/Observer 适配。独立 managed worktree 已建立。suite ZIP SHA256 与 PR169 记录一致。

## 重大决策
- 精确目标 DSH0.2.1-alpha.2/Cordis4.0.5-alpha.1；Codex0.2.0-alpha.3本地alpha2适配包，明确不同于registry同名包。
- 排除插件市场；不以 npm CLI 版本或退出码代替插件加载/业务历史恢复证据。

## 重要信息
- 正式 DSH_HOME D:/dsh_home，Node D:/soft/node-v24.19.0/node.exe，profile-native CLI；既有数据根从实际配置读取。


- 2026-10-13：最终全套隔离profile native plugin add成功；无旧DSH lock引用、无peer/compat警告，health ok、platformClients可用，关闭隔离端口。Host升级hook真实零写check通过、12项回归通过。统一manifest11直接依赖、本地包已按独立SHA256放正式packages但未更改profile。


- 2026-10-13：历史Convergent的range是Session seq，按各原生迁移边映射；generation是replace次数，v2→3插入system replace必须按源/目标计数转换。四条迁移边均需精确owned schema及未知/恶形负例。
- 2026-10-13：实际浏览器发现旧图标API导致设置卡片React异常；精准替换官方Regular导出，保留原size，正在重跑独立浏览器。历史owner在turn结束后合法投影tool/result，V4严格关系拒绝；需验证owned身份与原回执并映射投影内部sourceSequenceId。正式实例尚未停机。

- 2026-10-13：81现场会话官方JSONL readonly gate通过，24488 transformed events/82业务身份保留，原v0 bytes不变；逐edge144 Convergent records和288range端点通过，v2→3新增118replace准确重算。writer flush/reopen及最后source负例仍执行，SG4尚不完成。

- 2026-10-13：实际writer flush揭示官方JSONL worker静态bundle迁移闭包，四edge override只影响主线程readonly。新增唯一JSONL本地包重建worker，保留官方主线程源码；需同时packed/installed worker摘要证明。不绕过worker发布verify，正式仍未动。

- 2026-10-13：最终candidate nativeboot/main+worker字节及最新81现场副本通过；root实际producer27新事件write/flush/coldreopen通过，五包定稿，正式零写Check通过。现在进入既有维护封存部署，尚未声称正式上线。

- 2026-10-13：首次正式启动失败（缺cordis-plugin-group）；安装策略差异为根因：alpha2原生hoisted/noautopeer与初次candidate默认策略不一致。已保持sealed/stopped，追加原生策略候选及专用薄offline续接，不改原冻结证据。新缺失25required peers闭包正在冷装验证。

- 2026-10-13：原生hoisted/noautopeer冷装候选通过；薄offline continuation Check117输入零写通过，正式38依赖安装并启动PID39344，3080/18998同PID。启动后约50秒patch从ffadc变248163（87286bytes），AST保留原Unified注释并新增欢迎/模型/权限/主题设置。维护仍active revision772，等待来源及完整差异审计，不改旧冻结证据。

- 2026-10-13：采用当前并行设置新基线，不覆写未证实变更。135冻结链+117原输入实际复验；正式UI/preset/provider、完整任务/包/Web回读通过；原Resume一次恢复，延迟仍PID39344、maintenance inactive773、inboundtrue/Bridgehealthy/recovery0。唯一剩余SG6源码PR归档。
