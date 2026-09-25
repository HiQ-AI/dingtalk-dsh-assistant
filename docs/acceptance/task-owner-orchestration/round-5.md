# 第五轮：任务编排职责收口

## 范围与结果

按 `docs/spec/task-workflow-responsibility-refactor.md` 的 R1–R4 做定向功能与本地切换验证。`node --test --test-force-exit` 分两组运行：Owner/服务/通用能力/UAT 平台等 109/109，通过；执行控制/存储/原生会话/交付/发布平台等 82/82，通过。启动首次暴露历史 `task-general` 定义误收 `file.write` 能力，Resident 报 `GENERAL_CAPABILITY_INVALID`；只调整历史定义的只读目录后，服务与通用能力定向复跑 75/75，通过。`node --check` 与 `git diff --check` 通过。以上为本地功能证据，未执行真实 PR 合并或 UAT 发布。

## 用例证据

### w01
测试 `execution-task-plan`、`workflow-service` 验证 Task 与 Owner 原子接纳、初始零阶段，I 的 `workflowPlan` 被拒；Owner 初始化后才创建 Run。

### w02
`workflow-service` 的纯排查与续办用例验证排查阶段成功后保持同 Task，不自动添加开发与部署。

### w03
四阶段 Task 的排查、方案、确认、开发、UAT 顺序及确认门禁由 `execution-task-plan` 定向测试通过；真实 UAT 合并、部署和提测尚未执行，记 PARTIAL。

### w04
`workflow-service` 验证专业分析后同 Task 读取前序产物，零阶段 Task 可直接选择通用能力；没有 `task-general-intake` 前置要求。

### w05
服务层与 Task 计划测试验证阶段 Run 成功不自动使 Task 目标满足，Owner 仍需完成验收或追加阶段。

### w06
`execution-task-plan`、`workflow-service` 验证新要求递增要求版本、旧成功计划不能完成新要求；进行中的 Run 保持冻结输入，Owner 修订未完成后缀。

### w07
服务层从已完成阶段中查找工程或合并来源，不依赖紧邻阶段；插入真实 PR 评审阶段的完整链路尚未验证，记 PARTIAL。

### w08
`workflow-uat-merge-platform` 验证精确 PR/head/目标/检查/审批匹配；head 漂移、检查失败、缺写端口均零合并。

### w09
同一测试验证合并回执丢失后只读对账，不再次发送合并请求。

### w10
`workflow-uat-proof` 验证独立 UAT 部署无需工程 Run，但要求精确已合并 PR 来源与 Git tree。

### w11
`task-release-workflows`、`workflow-trusted-platforms` 验证生产与数据变更审批绑定精确对象，范围变化须重新审批。

### w12
`workflow-service`、`message-ledger` 验证报告变更不重跑业务，最终报告领取时检查最新要求版本和输入屏障。

### w13
`task-general-workflow` 验证 Markdown 文件固定受信目录、冲突不覆盖、物理回读；效果账重启对账不重复写入。

### w14
`execution-store` 真进程强杀用例验证 Owner 已接纳决定的恢复；`execution-task-plan` 验证零阶段、待确认及新要求版本。

### w15
活动库 `D:/dsh_home/workflows/runtime-v2/control.sqlite` 在停止 DSH Web 后运行 v4 `--check`：`writes:0`，未知效果、待审批、待应用 Owner 决策均为 0。`--execute` 产生 `pre-task-workflow-v4` SQLite 备份，回读 `PRAGMA user_version=4` 和 `execution_meta.schema_version=4`。备份/当前库 Task/阶段/Run/效果/消息行数均为 1/1/5/13/409。精确 tgz 安装后，关键源码文件 SHA256 与安装目录一致；新 PID 14904 监听 3080/18998，`18998/health` 为 `status:ok`、`recoveryIssueCount:0`。

### w16
服务层及通用能力测试验证仅有聊天材料时无法宣称完成数据库调查；缺少能力或客观验收证据保持可见阻塞。

## 未闭环边界

真实 dataset/dataset-web PR 当前没有可核验的 requiredChecks 策略；`uatMerge.targets` 和写端口不能凭空启用。故 W03 的真实 PR 合并→UAT 部署→提测及 W07 的插入评审完整路径仍为 PARTIAL。健康与合成合同不代表钉钉通知送达或真实 UAT 环境版本回读。
