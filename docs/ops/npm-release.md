# npm 正式发布

本仓库使用 npm Trusted Publishing（OIDC）从 GitHub Actions 发布三个公开包，不再使用 `NPM_PUBLISH_TOKEN` 或 `NPM_TOKEN`。GitHub Actions 的短期身份只用于 `npm publish`；npm 查询和 GitHub Release 分别使用公开 registry 与 `github.token`。

## 一次性配置

在 npmjs.com 的以下三个包中分别打开 `Settings → Trusted publishing`，添加同一条 GitHub Actions 配置：

- `@zzusp/dingtalk-dsh-observer`
- `@zzusp/dingtalk-dsh-assistant`
- `dingtalk-dsh-assistant`

配置值必须完全一致：

| 字段 | 值 |
| --- | --- |
| Organization or user | `HiQ-AI` |
| Repository | `dingtalk-dsh-assistant` |
| Workflow filename | `release.yml` |
| Environment name | `NPM_PUBLISH` |
| Allowed actions | 允许 `npm publish` |

npm 保存配置时不会验证字段。三个包都配置完成后，再将 Publishing access 设为 `Require two-factor authentication and disallow tokens`；Trusted Publisher 不受该 token 限制影响。修改 Trusted Publisher 或 Publishing access 必须由维护者交互式完成 2FA，不能用 bypass-2FA GAT 代办。

GitHub Environment `NPM_PUBLISH` 保留审批/保护规则，但应删除不再使用的 `NPM_PUBLISH_TOKEN`、`NPM_TOKEN`。不要在仓库、Environment 或 workflow 中新增写权限 npm token。

## 发布

1. 明确最新 main SHA，检查新增提交范围，同步三个版本、锁文件和 CHANGELOG。原工作区未提交内容及未合并实验分支不得带入。
2. 本地 Node24.19.0 / pnpm10.13.1 冻结安装，运行本次相关回归及 `pnpm test:release-smoke`。不再在本地重复前置全量；大改必须补风险相关测试，测试成功不等于真实模型或渠道验收。
3. 必要 PR 经审查合入 main，创建指向最终提交的带注释版本 tag。Release 的 resolve 固定 tag SHA、main 历史、三版本和 changelog；后续 jobs 只 checkout 此 SHA。
4. validate 六个独立 Windows runner 按 test/suite-map.json 完整执行全部映射：unit 并发4，native两组及兼容三组各并发1；不提高同机并发挤压原30秒阈值。首次版本保留所有历史覆盖，退出任何测试必须另审其导入图与当前发行/兼容合同，不能按文件名或失败结果删除。每文件的依据和分组见完整映射；修改测试集合/导入须更新并审阅映射。
5. 所有验证分组成功后 build 仅从同 SHA 构建三个 tgz，清单绑定 runId、SHA、tag、lock/profile摘要、Node/平台及固定pnpm配置，记录每包name/version/size/SHA256/SHA1。真实原生包 smoke 读取这批已打出的包；smoke 后再次校验摘要，才上传同 run 的不可变 artifact。
6. publish 需要 build 成功且保留 NPM_PUBLISH 保护。它没有安装依赖、构建或测试步骤，只下载本 run 同 SHA artifact，核对 checkout/tag/SHA、清单、lock/profile、环境和每个 tgz，再使用原 OIDC 按 observer→assistant→根包发布。精确 npm 版本回读成功后才创建三个 tgz 附件的正式 Release，并核验附件大小/SHA256。

仅 publish 失败时，对原 run 重跑失败 job（gh run rerun RUN_ID --failed），不要重新 dispatch、重新打包或换 tag。已发布 npm 包仍比较 SHA1，冲突即停。下载只针对同一 run 的 SHA 命名 artifact，不接受外部 run/token；artifact过期、缺失或摘要不符必须停止，重新完整验证同 SHA，不能盲缓存通过结论。重跑成功后仍独立读取 npm 和 Release。

依赖缓存只用官方 setup-node/pnpm 与 setup-java/Maven，键受锁文件/工具设置约束；不缓存测试结论。手动 ci.yml 保留完整扩展兼容验证入口，无 PR/push/每日定时触发。流水线不部署、重启、改运行配置或加载用户凭据。

## 验证与故障定位

发布完成后分别回读，不能用 Actions 成功替代 registry 或 Release 证据：

```powershell
npm view @zzusp/dingtalk-dsh-observer@<version> version --registry https://registry.npmjs.org/
npm view @zzusp/dingtalk-dsh-assistant@<version> version --registry https://registry.npmjs.org/
npm view dingtalk-dsh-assistant@<version> version --registry https://registry.npmjs.org/
gh release view v<version> --json tagName,url,assets
```

OIDC 发布失败时依次核对：workflow 使用 GitHub 托管 runner；权限含 `id-token: write`；npm CLI 不低于 11.5.1；三个包的 Trusted Publisher 均精确匹配组织、仓库、`release.yml` 和 `NPM_PUBLISH`；三个 `package.json` 的 `repository.url` 精确指向当前公开仓库。`npm whoami` 不会显示 OIDC 身份，不能用它判断 Trusted Publishing 是否生效。

## 1.0.0 升级边界

1.0.0 汇总 0.5.15 之后的 workflow-v2、Task Owner、领域业务验收、文件投递及任务目录变化。升级前先按[本地部署说明](resident-review-local-deployment.md)确认运行实例和在途任务，保留控制库、Domain、原工件/会话目录、profile 与 Agent 工作区 `tasks/` 的完整备份。

产品版本不决定存储迁移：只有旧 JSON domain v8 才执行[工作流存储迁移](workflow-storage-migration.md)，v6/v7 先经[Topic 迁移](topic-storage-migration.md)到 v8；已切换 v9 / workflow-v2 的实例不得重复迁移。历史冻结工作流按原摘要恢复，旧任务文件默认原路径读取；终态任务收纳只按明确计划操作，DSH 原始会话目录保持原位。

新数据或外部效果发生后不能直接恢复旧快照；先停止派发和对账，再制定保留新增事实的回退或前向修复方案。包发布、实例升级、业务完成和真实渠道送达分别回读，npm 发布成功不代表任何实例已升级。

## 发布测试环境

测试临时根必须是当前执行身份可写、祖先目录可回读的物理目录；可通过 `TEMP` / `TMP` 指定隔离工作区，不使用写死的 `/tmp`。Windows 进程与端口所有权验收仍需要系统允许其既有只读查询；访问被拒时按环境阻塞报告，不删除检查、不把失败改成跳过。合成 Node 服务的测试 owner 通过专属 IPC 请求自然关闭，并等待其实际 `ChildProcess` 的 `close` 事件；这只负责测试自身资源收尾，不替代产品的进程树或排空验收。

测试需要真实 JDK11（`JAVA_HOME` 指向其安装根），前端启动用例还需 `NODE22_EXECUTABLE` 指向真实 Node22；仓库与发布本身仍使用 Node24.19.0。测试所用 YAML、Cordis 和 Loader 来自仓库声明依赖，不要求预先安装本机 DSH profile。

Windows 专用临时测试目录须向当前执行用户继承授予 FullControl，供原生沙箱设置子目录 ACL；仅能写文件的 Modify 权限不足，会在 SetNamedSecurityInfoW grantWrite 阶段报 Win32 5。这是测试环境权限准备，不修改产品沙箱策略。

全量测试前先执行 `mvn -B -f test/fixtures/local-acceptance-spring/pom.xml package`，从已声明的真实 Spring Boot 依赖生成合成验收夹具，不使用或发布业务 JAR。CI 与 Release 都显式准备工具和短物理临时目录；受管路径的链接/越界检查保持原样，不因 runner 的系统临时路径而放宽。较深临时根会触发部分 Git for Windows 命令的路径限制，须使用短物理根。

## 2.0.0 候选的测试范围对齐依据

依据当前 README 的运行时边界、三个发行入口的实际依赖图及 Assistant 显式发布清单，旧 workflow/Owner/消息账编排不再由 resident 装配，其源码只供历史取证。本次按用户要求移除下列整组旧架构测试，不只摘除失败断言；历史源码、Git 记录及原 CI 失败证据保留。测试总数下降不能计作新增通过。旧 Git/Run 固定自动化功能本身退出，不宣称所有旧覆盖已等价迁移；表中仅列仍保留的当前产品覆盖。

| 移除的测试文件 | 已废弃的受测合同 | 保留的当前覆盖 |
| --- | --- | --- |
| `development-branch-purity.test.js` | 旧 `workflow-engineering`、Run/节点阶段与自动 PR 编排 | 当前 `task-session-service-native`、`dynamic-execution-session-native` |
| `group-reply-audience.test.js` | 旧 `workflow-notifications` 格式化及 Owner 固定提示词 | `group-reply-format`、`task-session-reply-identity` |
| `message-answer-cancel.test.js` | 旧 `workflow-service` 取消消息事项与 Owner 流程 | `group-coordinator-session-native`、当前 Task 会话控制回归 |
| `message-coordinator.test.js` | 旧 `message-coordinator`、`message-workflow` 和 execution-store | 当前原生群协调及 Task 来源/接续测试 |
| `message-ledger.test.js` | 已退役消息事项控制账的活动编排 | 当前 topic/store、`dynamic-task-store`、群协调测试 |
| `task-owner-session-native.test.js` | 旧 Task Owner 独立编排层与 task-owner-controller | 当前 `task-session-service-native`、`task-session-persistence-native`、回复身份回归 |
| `workflow-service.test.js` | 已退役 workflow-service、Run/节点及旧领域流程活动执行 | 当前 Task 服务、会话恢复、材料权限、通知与原生执行回归 |

这些文件对应候选提交 `fe07ee8` 完整 CI 中的 52 个失败，但删除依据是受测合同已经退出当前产品，而不是失败本身。`coordination-latency-native`、`task-release-workflows` 和 `task-session-material-history` 仍有有效保证，不在删除范围。

仍有效的看板测试补齐真实 `ExecutionSessionDuration` 定义，检查三种状态的可访问语义而非过时的 SVG 总数；模型上下文测试使用 `node:path.relative` 核对目录内路径，继续读回全部原内容。未修改产品源码或降低字节预算。

完整原生材料测试要求 `test/fixtures/task-session-native-host.js` 声明的完整组合。CI/Release 通过 `DSH_NATIVE_TEST_PROFILE` 显式指向 private 合成 workspace `test/fixtures/native-profile/package.json`，冻结安装后预检 37 个真实原生模块；夹具不包含用户 bundle、provider 配置或凭据。锁文件新增完整组合并改变若干 Assistant 依赖的 peer 上下文，原有包版本未升级，不能据此声称依赖解析完全不变。未设置变量的本地测试仍默认使用 resident profile；不得删除有效材料权限测试或把缺环境改成通过。

固定摘要属于 `runtime-contracts-archive.md` 明确保留的历史字节完整性保证。`3601f29` 的两个 v4 函数与上次绿 CI `88181c2` 语义相同，但换行从 LF 变为 CRLF；原 LF 摘要仍匹配原测试常量。本轮已恢复 `88181c2` 的原始混合换行字节，Git blob `9af03f7ec38b8ff2fe0105038aa1ce1aee0bc613` 完全相同；规范化内容不变，原断言及期望摘要未改，两项定向回归通过。归档文件不进入当前正式包。群协调公平续行的重试计数断言也保留。基线最小用例的 1 次重试实际来自旧模型夹具未处理的摘要迁移请求，原、新话题决策均为 0 次。夹具现按真实 `group_topic_summary_submit` 协议处理摘要，并仅用 decision 角色更新决策指针；9 次非法纠正、10 次原请求调用、新任务先行以及全部请求 0 重试断言不变，定向回归通过。
隔离原生材料回归中发现合成模型误将 `coord-summary-*` 请求提交为路由，已补齐真实摘要协议分支，未改生产代码。材料文件本机 15 项中 13 项通过；两项创建符号链接被 Windows 返回 EPERM，保留原断言交由托管 CI 实测，未变更系统权限。

Windows 原生 Task 来源夹具直接检查工具文本中的绝对路径，避免 JSON 序列化反斜杠转义导致重复读取。真实读取、正文去重、原始审计与完成断言保持不变，权威来源定向回归通过。

`df6eb20` 的完整 CI `38922011709` 结果为 3204 项：3156 通过、38 失败、6 取消、4 跳过，未进入打包上传。隔离组合补齐 `api-session-controller` 与 `file-reference-local`，冻结安装及 37 模块预检通过。原生夹具将 `coord-summary-*` 维护调用与 owner/executor 故障计数分开，维护请求保留在 `auxiliaryRequests` 供审计；自定义 Provider 同样先处理维护协议。人答模型按当前 `sourceId` 读取真实答复，按原执行版本决定续办；执行结果沿 `catalogRef` 精确读取，不要求缩减快照重复内联正文。合成 Resident 仍须提供 ownerActorId、webActorId 与有效 ingressEpoch，不能绕过运行时校验。

后续诊断确认通知旧夹具在同进程直接写入账本，绕过服务缓存更新；正常发送及真实冷重启诊断 2/2 通过，不能据此声称正常运行或重启存在用户可见故障。恢复用例改为真实关闭/重开服务，保留跨实例发送审计及 own-notification、冻结消息、防重发与已送达状态断言，不增加产品防御性代码。

针对 `df6eb20` CI 的原 44 个失败/取消用例，补齐上述测试环境与模型协议后，13 个文件的串行定向复核为 42 通过、1 失败、1 超时取消、0 跳过。失败仍是已送达通知身份缓存；超时为完整冷恢复用例超过原 30 秒，单独运行曾在 24.68 秒通过。尚未增加超时、修改产品源码或重新触发完整 CI；不能把这份定向结果称作整套通过。证据应按本轮日志回读，不以此历史记录替代当前运行状态。

保持相同隔离 profile 和原 30 秒阈值，冷恢复两次重复定向均通过（约 23.6 / 22.6 秒，含启动），随后原生执行 Provider 整文件 8/8 通过、0 取消、0 跳过，整文件约 104 秒；真实重启通知恢复用例 2/2 通过。未减少恢复轮数、增加超时或修改产品逻辑。较早并行/连续运行的 30 秒超时仍保留为风险证据，不能由这次定向确认推断全量 CI 已通过。
