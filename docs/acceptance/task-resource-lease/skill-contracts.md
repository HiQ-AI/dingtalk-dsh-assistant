# 现有 skill 与合并预检交付

日期：2026-10-21。范围：更新实际运行目录 `D:/dsh_home/skills` 的三个现有 skill，不新增 skill，不修改健康 runbook，不执行合并、上传或部署。

## 已实施

- `business-development`：构建前固定目录、HEAD/tree/未提交输入身份；运行中不编辑、合并或切换同一检出；结束后核对输入，漂移须另起一轮验证受影响候选。共享交付引用 UAT PR 的同一资源规则。
- `uat-pr`：集中说明 Host 整段 execution 的资源占用与等待；`queued` 不代表 `held`，读 `resources.state/keys/holder/blocking`；结果提交不释放，等 drained 与全部操作终态。遇漂移自行调查真实持有者与在途发布，不造旁路锁、不交用户代查。
- `uat-pr`：集成夹具先适配目标已有权限和校验入口；正向用例最小合法授权，保留无权限、非法输入负向断言，不删除生产门禁。
- `uat-pr`：现有 UNKNOWN 规则接入只读公共 helper，禁止用写操作试探平台是否允许合并。
- `uat-deployment`：引用共享资源规则；健康脚本使用 `&` 调用后立即捕获 `$LASTEXITCODE`，同时检查退出 0 与 JSON `healthy=true`。健康、镜像版本和业务验收各自取证。

新增 `uat-pr/scripts/read-github-mergeability.ps1` 的理由：现有技能只有文字约束，没有可复用的精确对象读取及 UNKNOWN 有界处理入口。脚本只调用 `gh api --method GET` 读取精确 PR 和真实目标 ref；最多默认 3 轮，UNKNOWN 默认间隔 2 秒。拒绝漂移、错对象、非 OPEN、Draft、明确不可合并和已知阻断；不重试写操作、不执行合并、不输出原始服务错误或凭据。

`approved=true` 的范围仅为观察时刻的对象身份与可合并性；required checks、审查、验收和用户授权仍须独立核验。`unstable/has_hooks` 并不由本 helper 证明检查通过，调用方不得据此绕过失败的必需检查。平台互斥也不能阻止外部系统发布，因此真实 head/工作负载漂移检查仍保留。

## 验证

| 验证 | 结果 | 证据 |
|---|---|---|
| 三个 skill 的 quick_validate | 3/3 通过 | `python -X utf8 D:/codex-home/skills/.system/skill-creator/scripts/quick_validate.py <skill目录>`；三次 exit 0 / Skill is valid |
| 修改涉及的入口与 procedure 本地引用 | 14 项全部可解析 | 逐个解析 Markdown 本地链接并检查实际路径；missing=[] |
| helper 隔离行为测试 | 23/23 通过 | [测试脚本](scripts/merge-preflight.test.ps1)、[结果](merge-preflight-results.json) |
| 真实 GitHub 只读 GET | 通过 | [真实结果](merge-preflight-live.json)：dataset #353，精确 head 与真实目标 ref 匹配，mergeable=true/clean，退出 0；未执行任何外部写入 |

测试每例使用独立 `pwsh`，mock `gh` 只允许显式 GET。覆盖正常、UNKNOWN 后明确可合并、持续 UNKNOWN、boolean true 但 state unknown、重读期间 head 漂移、false、head/base/branch/repository/PR 身份变化、关闭/已合并、Draft/缺失 Draft、blocked/behind、字符串假 boolean、未知状态、读取失败、无效 JSON，以及仅可合并性不能证明 checks 的边界。每例先运行返回 17 的原生命令，再验证 helper 的退出码不沿用该值。

## 验证期间发现并纠正

1. 首次测试的 mock 状态使用 `$script:`，被测脚本切换脚本作用域后找不到状态，clean 正例得到 `github_read_failed`。已改为名称独占的全局测试状态，正式 helper 未为 mock 增加参数或分支。
2. 模拟测试初轮通过后，真实只读查询发现 GitHub PR `base.sha` 仍是历史快照，而当前目标 ref 已前进且 `mergeable=true/clean`。原 helper 误把两者不同当漂移，初次拒绝结果保存在 [初次现场记录](merge-preflight-live-initial.json)。已改为以独立读取的目标 ref 为身份权威，PR base SHA 仅记录；将“缓存 base 不同而真实 ref 匹配”补成正例，完整 23 例重跑通过，真实 GET 再跑退出 0。真实 ref 漂移仍明确拒绝。
3. 独立六场景审查反馈资源查询的 Agent 入口不够明确，已精确补充统筹使用 `task_execution_read`，Host/API 审计使用 `execution.get/list`；前者限于本任务，其他 holder 仅通过已有授权的跨任务只读入口核对。能力不足保留等待、说明查询边界，不猜工具或跨作用域调用。其他两个 skill 继续引用此统一合同。该轮只改文档，重新执行三个 quick_validate、14 项引用检查并更新文件 SHA256，未重复执行未改动的 helper 测试。

## 边界

静态校验和脚本行为证据已完成；三个 skill 的独立 Agent 情景演练交由主代理安排，不能仅凭 quick_validate 宣称模型行为已验证。插件生命周期与实际安装由主代理验证，公共健康脚本与 runbook 由对应子代理验证。本报告不把这些其他验证范围计入本子任务的通过结论。
