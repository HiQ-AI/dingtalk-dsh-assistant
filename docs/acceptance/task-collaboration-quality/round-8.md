# 第8轮：双后端冻结复验与交付

这是 SG7 修复后的验收轮次；实现成员仍沿第7轮职责协作，不新增团队或覆盖旧记录。证据文件保留在生成时的 `round-7/`，本文件固定最终结论。逐用例状态以 matrix.csv 为准。

## 冻结候选与验证

CLI 适配器 SHA256：`1cb9e0123657080f99b73732115b666072bedb34c9b5b9c08d73589d9ff82a77`。独立测试运行前后摘要相同，真实 CLI 最终两轮结果也绑定该摘要；之后只整理文档和交付记录。

- `round-7/cli-native-independent-4.log`：真实 Host 子进程管理、管道及 HTTP MCP，固定协议子进程完整 **26 PASS、0 FAIL、0 SKIP，14.60 秒**。含取消父/孙进程、resolve/spawn 竞态、在途回调排空、真实文件前置操作账、反馈顺序、坏流、原身份续办、链接日志拒绝、缺可执行文件重试、drain 不足保留占位和关闭 listener、后台回执保留 unknown。
- `round-7/cli-adapter-results.json`：本机真实 **Claude Code 2.1.212 + Host subprocess + 生产 Store** 两轮离线 PASS，6.325 秒，合成模型分别 6/5 次请求。第一轮 Write/Read/progress/team/submit；第二轮同 UUID resume，唯一 Write operation 为 succeeded，没有重放。journal、SQLite、实际文件及两轮文档由独立成员回读。禁后台开关实传；Bash schema 未提供后台参数。原始材料在 docs/tmp，不提交凭据、临时配置或整段轨迹。
- `round-7/backend-routing-1.log`：混合团队真实服务 + SQLite 1 PASS；覆盖默认 DSH、配置切换、新建 CLI、续办后端不变、旧轮文件字节不变、重启不重放及 CLI 不错误注册原生会话。
- `round-7/backend-documents-2.log`：文档、模型投影和归档 **29 PASS、0 SKIP**。Store 103 项通过；R7 原生回归中的 provider 9、stage 3、HTTP 均已通过，不因归档夹具修正而重复跑未变生产路径。
- `round-7/backend-suite-map-2.log`：**301 文件、历史 3、删除 0**，每文件唯一分类；未更改历史 hash 或放宽门禁。`backend-test-contracts-1.log` 的守恒合同 **12 PASS**。
- `round-7/backend-release-smoke-2.log`：完整发布 smoke **14 PASS、0 FAIL、0 SKIP，49.743 秒**。真实打出并提取 tgz，运行个人技能团队任务和 resident 健康检查；新适配模块进入显式包清单。首次失败的过期映射日志保留。
- 配置/UI 证据见 `round-7/config-execution.md`：17 PASS + 缺 registry 的跳过由官方 Web profile 3 PASS 补齐；最终 UI 112 PASS、Observer 71 PASS；真实 Chrome 与 audit 通过。最终帮助文案重建后官方加载再验 3 PASS，不重跑未变交互。

## 证据边界

用户后续自行登录 Claude，本轮未验证真实账号模型 run/resume、真实多成员 CLI peer 往返或跨模型请求的所有反馈顺序。协议及混合团队夹具覆盖对应实现合同；真实 CLI 两轮只证明其明确列出的协议路径。该两轮探针未在切轮前记录旧文档 SHA，不用它替代混合团队和 SG6 的冻结断言。

CLI 使用自身默认模型，不接收 DSH 模型/preset/Skill 注册表；严格工具与权限桥不等于 OS 沙箱。未知效果和无法证明排空均保留原保护，不移交替身或重放。未触发 CI、未合并、未部署现场、未执行真实钉钉或外部业务操作。Git/PR 状态在独立回读后另补。

## Git / PR 独立回读

代码提交 `9f2b8167a51e5accec76b183cabc99bd88293542` 已推送。`git ls-remote --heads origin worktree-task-collaboration-quality` 与本地提交相同；`gh pr view 248` 独立返回 number=248、URL=https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/248、state=OPEN、base=main、headRefName=worktree-task-collaboration-quality、headRefOid=同代码提交、mergedAt=null、checks=0。标题已更新为“完善任务团队协作、逐轮文档与可选 Claude Code 执行后端”，正文规范化换行后与通过检查的文件逐字一致。

源码 diff 格式、long-goal validator、PR 正文结构检查和最终 suite-map 均通过。原始 stdout 的行尾空白保留，diff 检查仅排除 .log；docs/tmp 原始模型协议、临时 SQLite 与 PR 草稿未进入提交。后续仅补本交付记录，不重复已通过的源码验证。
