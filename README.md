![钉钉群聊中的 DeepSeek Harness 数字员工](docs/manual/images/dingtalk-dsh-digital-employee.png)

# DingTalk DSH Assistant

看板顶部提示均支持手动关闭；操作成功提示在 5 秒后自动关闭。连接和操作错误保留至手动关闭或问题恢复，同一次持续错误不会因自动刷新反复弹回。

`dingtalk-dsh-assistant` 把钉钉群聊接入 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/DeepSeek-Harness)。当前 resident 使用“消息 → 话题 → 任务会话 → 独立执行会话”：消息只归属话题，既有话题协调器结合固定版本原文与新消息决定是否创建、续办、取消任务或仅讨论；任务会话持续负责完整目标，独立执行会话使用宿主实际工具完成受托工作。

当前源码不再装配固定 workflow、DAG、阶段或节点调度器。按清洁启动使用全新任务库与 Resident domain，旧任务数据可恢复地移出运行路径；当前服务不读取、导入或兼容旧任务，也不重新发送旧通知。既有实例不能直接热切换，先读[任务会话清洁启动 Runbook](docs/ops/task-session-clean-start.md)。本文描述源码行为，不表示已发布、已部署或通过真实钉钉验收。

## 任务责任与执行边界

- 原消息、话题单元、归属版本、摘要及决策操作记录继续持久保存。原路由与话题决策按角色使用原生协调会话，只解释、归属和交办真实来源，不执行业务工作；消息不直接保存任务关联。
- 每任务一个持久任务会话（Owner），独立维护当前目标、需求版本与控制版本。它可直接使用当前 Agent 配置提供的原生工具、按需读取技能，也可委派、读执行结果、取消执行及提交本轮结论；不另设统筹会话工具白名单。
- 每个受托执行有自己的 `executionId`、原生 Session、租约和工作目录。同任务可并行多个执行，同一执行只能单飞；续办沿原 Session 与递增输入版本，不伪造 Run/节点。
- 任务会话根据当前要求与真实结果自主判断继续、等待、提问或完成。Host 检查来源、版本、权限、未排空句柄与未决 operation 等一致性，不代替模型做业务阶段验收。
- 任务与执行会话均挂载实际配置的 DSH Agent preset，恢复时沿已持久选择；任务和动态执行会话均保留该配置的原生工具，不额外设置会话工具白名单；工作区指引、沙箱、审批及操作账身份仍以宿主和当前真实授权为准。会话可使用实际已配置的原生委派工具，具体操作仍须有当前用户授权。

话题决策先落原话题账，任务与用户来源再落 SQLite 账，然后创建会话。每任务沿配置工作区的 tasks/<taskId> 使用固定工作区，原生 workspaceRegistry 以任务标题显示；任务与独立执行会话的原生归属均为同一任务根目录。同一任务的任务会话与全部执行会话也在同一任务根目录实际运行，文件可共享；不同任务使用不同根目录。恢复保留相同工作区、运行目录和会话身份。任务会话标题使用任务标题，执行会话标题使用受托小目标名称。执行结果与唤醒任务会话的事件在同一事务提交；旧需求的迟到结果只作为历史证据，不能改变新要求。暂停或取消使旧分派权限失效，只有真实工具、会话及受管进程排空后才能释放执行占位。“取消请求已记录”不代表外部动作已撤销。

## 持久账、通知与恢复

动态控制库独立记录 task、execution、operation、source、wake 和 notification，不依赖旧 Run/节点外键。命令回执和稳定分派键防重复；结果已写入原生日志而回调尚未落账时，恢复可以重收已确认提交，不再调用模型重做工作。

外部 operation 先持久登记再执行。`starting` 在重启后成为 `unknown`；原未知记录及其已有资源锁保留，不能换 ID 或换参数自动重放。新原生调用沿 DSH 自身的权限及并发合同，不再分配插件合成的通用写锁，也不因另一个操作未知而全局拒绝 GitHub/终端等查询；原操作对账和业务完成证据继续独立核验。

业务完成与通知送达是两件事。完成结论和唯一完成通知意图同事务提交；话题确认、必要业务问题、用户主动状态查询也使用独立通知账，并投影回原群消息发件箱。话题决策的全部任务动作落账后才准备回复，动作失败不发送成功承接表述；恢复按原动作和通知身份去重。话题固定历史中的自身通知只作为上下文，不作为用户授权来源；同账号手动输入仍须精确版本准入。发送后必须独立核对目标群、真实消息及身份/引用证据。ACK、工具返回成功或业务完成均不等于通知送达；未知通知只回读，不重发业务或原消息。Web-only 来源不自动转成群聊外发。

发信箱按发送状态、原因、替代关系、撤回结果四个维度展示和组合筛选。现行通知账是发送状态唯一依据：待发送、发送中、待回读、待核对、投递异常、已停止、已送达；待核验等停发原因独立展示。内容替代和真实撤回记录不覆盖送达或未知结果，也不承诺执行旧群撤回。无现行通知状态的旧记录只读适配；历史仅有发送记录而缺少回读证据时显示“已发送”，原因注明缺少回读证据，不明记录保持待核对。历史诊断保留，不宣称旧流程仍会重试。发送时间来自核验后的钉钉原消息；历史缺失显示未记录，并单独标注回读确认时间。

收信箱处理状态按当前归类结果和话题处理版本展示为待归类、归类失败、话题处理中、已处理；不再展示旧工作流等待状态或“历史未记录处理过程”提示，已有处理记录仍可查看。

收信箱过滤已关联的自身通知及当前发送身份的 DWS 回流，保留底层历史；本人手动发送的正常消息仍经监听和历史补拉接纳。仅账号相同不能判定为通知。DWS 不返回原生 `@` 元数据时，只有精确发送状态 SUCCESS、消息 ID、发送者、原群、原生引用及完整正文全部吻合才确认送达，同时记录 `mentionVerification=unavailable`，不声称 `@` 已核验；明确不符的元数据仍拒绝。无精确回执的历史匹配继续要求原生 `@` 证据。

更新运行实现后，启动时因未知操作而停住、没有人工问题且执行均已排空的任务，会按实现摘要和需求/控制版本补一次持久恢复唤醒。原任务先只读对账，不清除未知效果保护或重放原命令；同一实现的定时恢复和再次重启不重复唤醒。

开始、普通进度和内部诊断不会逐条群发。群内最终结果引用来源消息并按受信身份提及相关用户，正文直接写答复，不再重复被原生引用的消息原文；原始编号、诊断与过程留在任务详情。

人工介入按 `audience` 分流：缺省 `operator`，插件/任务/底座/登录/工具能力等技术问题保留在现有 Web 人工介入页，并发给当前 DWS 登录人私聊；身份从同一 profile 的认证回读取得，不取业务需求提出人。仅明确需要需求提出人回答的业务信息或业务决定使用 `requester`，才在原群询问。真人可在私聊引用申请回复结果；Host 核验原通知、会话、真实作者和当前申请版本，再沿原任务继续。无当前登录身份或未授权外发时保留 Web 入口，不退回业务群。私聊发送结果未知只回读，不重发。

### 首版限制

- 动态原生执行的显式后台调用校验并立即返回原生 job 身份，服务可供同一执行的后续工具使用；前台超时提升仍收集终态。后台 operation 在真实终态前不结算，执行结束或取消时停止残留 job、记录终态并排空所属进程。原生 job_list/job_output 固定为读取；旧版误记未知的缺失 job 读取只按原收据核验失败，不重放生产者命令。缺少可核验身份不能视为成功，已启动不等于服务就绪或业务完成。传统工作流节点仍保持既有后台限制。模型服务故障按[Provider 恢复机制](docs/spec/execution-provider-recovery-mechanism.md)有限退避，不重放已成功操作或未知效果。
- 通过原生 subprocess 服务创建的进程按该 provider 的 `terminate` / `waitForExit` 合同排空；无法证明排空时保留占位。这个保证不超过 provider 的实际受管范围。
- 动态任务执行不再挂接插件的文件路径拦截；任务日志及当前已授权文件沿原生文件工具、sandbox/approval 和实际操作系统权限读取。工作区与原任务/会话归属不变。
- 通用执行依赖实际 preset 能力；旧工程、UAT、Bytebase、文件交付等固定流程不再是新任务入口。保留源码和历史合同不代表动态任务已自动接通这些旧适配器。

## 工作目录与原生日志

```text
<Agent工作区>/
  .dsh/task-sessions.sqlite           默认动态控制库
  .dsh/task-sessions.sqlite.initialized
  tasks/.session-routes/              原生日志持久路由
  tasks/<taskId>/materials/           共享材料
  tasks/<taskId>/outputs/             任务产物
  tasks/<taskId>/tmp/
  tasks/<taskId>/                     原生工作区及所有任务会话 header.cwd
  tasks/<taskId>/work/                工作文件容器
  tasks/<taskId>/.dsh/sessions/        该任务全部原生会话日志
  groups/<groupId的摘要>/             群会话 cwd
```

任务与执行的日志由官方 JSONL 后端直接写入任务目录，保持原生 replay、恢复和压缩能力；不是日志副本。群会话使用新 profile 配置的原生持久化根；旧会话不接入当前运行时，不能一概认定在 `%DSH_HOME%/sessions`。会话 ID、路由、控制库与工作目录需一致恢复。在线更换 Agent 工作区被拒绝；离线搬迁与恢复要求见[清洁启动 Runbook](docs/ops/task-session-clean-start.md#回退)。

## Web 看板与 HTTP 接口

任务页展示一项完整任务、唯一任务会话和动态执行列表；支持独立新建任务，不把内部执行拆成多个业务任务。详情包含结果、执行状态、日志入口和未决阻塞，不展示补充需求与取消任务控件；群消息续办和后端控制 API 仍保留。模型会话入口是阅读上下文，不是绕过 Host 直接修改任务的控制口。

- `GET /state/tasks/:taskId/detail`：当前任务及只读历史详情
- `GET /state/tasks/:taskId/executions`：动态执行或历史执行记录
- `POST /tasks`：Web 新任务，须配置受信 `webActorId`、指定订阅群并提供稳定 `requestId`
- `POST /tasks/:taskId/context`：补充要求，携带 `expectedRequirementRevision` 与 `expectedControlRevision`
- `POST /tasks/:taskId/cancel`：取消，携带 `expectedControlRevision`

Web 写入限制本机合法请求来源；操作者由 Host 配置，不接受模型提供身份。CAS 冲突须重新读任务，不能覆盖新版本。Web 的原始操作意图与来源同事务保存，重启不会交给群模型改判。

旧 `/workflows/*`、`/config/workflow-variables*`、`/config/workflow-bindings*`、工作流目录及旧阶段/重跑/暂停恢复/归档等写入口返回 HTTP 410。旧任务写入返回 `LEGACY_TASK_READONLY`；历史读取不赋予恢复权限。完整退役范围以 `http.js` 为准。

当前任务仅在“已结束”桶显示归档按钮（completed、cancelled、succeeded、failed），历史只读及已归档任务不显示。归档仍由服务端检查任务已完成或已取消且执行已结束；浏览器 OPTIONS 预检先于旧入口清退规则返回 204，实际写请求继续执行身份和状态校验。

## 包结构

- `packages/dingtalk-dsh-assistant`：DWS 传输、群配置、任务会话服务、动态 SQLite 账与设置页面
- `packages/dingtalk-dsh-observer`：任务、来源消息、结果、执行会话和历史只读看板
- `task-resident-runtime.js`：不含旧调度器的 resident 传输/配置边界
- `task-session-service.js`、`task-session.js`：来源接纳、群关联、任务统筹与恢复
- `execution-session.js`：复用 DSH create/resume、preset、租约、工具与排空
- `dynamic-task-store.js`：事务账、效果锁、幂等回执、唤醒及通知
- `task-session-persistence.js`：官方原生日志的任务级持久路由
- `docs/ops/task-session-clean-start.md`：切换、核验、人工对账与恢复

旧 workflow/Goal/叶子调度文档仅供历史维护取证，不是当前 resident 的操作指引。不得同时装配旧 `workflow-service`、旧 Resident scheduler 或独立 execution 恢复进程写同一实例。

发布清单采用当前入口依赖的显式白名单。退役工作流、私人平台适配器、历史业务源码和个人技能均不进入 Assistant npm 包，旧 `./execution` 与 `./platform-host` 导出已移除；它们只保留在源码中作历史取证。通用群消息、资源清理和当前来源规则独立成模块，避免无关的旧引擎被传递打包。`test/task-session-package-native.test.js` 实际打包、解压，以已安装依赖运行解压产物的任务和 resident 健康检查；不等于已经部署用户实例。

## 环境要求

- Windows 11 与 PowerShell 7。
- Node.js 24 或更高版本。较低版本缺少 DSH Session JSONL 持久化所需的 zstd API。
- 本分支适配 DSH `0.2.1-alpha.2`（用户指定的预发布版本），并要求能够正常启动 `dsh web`。Assistant、Observer、DSH 核心及服务 peer 依赖必须保持相同版本，不能混装旧依赖树。升级与会话格式边界见 [DSH 兼容说明](docs/ops/dsh-0.2.1-alpha.2-compatibility.md)。
- 已安装并配置所选模型对应的 DSH provider。只有使用 ChatGPT/Codex 订阅时才需要 `dsh-codex-connect`。
- 已安装并登录 DWS。只有启用真实钉钉订阅时才需要。

网络环境需要代理时，可在插件的 Agent 配置中填写代理地址，也可以在启动前设置 `HTTP_PROXY` / `HTTPS_PROXY`。

### Skill 文件路径

插件不内置个人 Agent 设定、技能正文、业务技能名单或业务目录。技能使用已配置 DSH 原生 `dsh-skill`、`dsh-skill-filesystem`、`dsh-tool-skill`；没有配置这些能力时不会自动安装个人技能或回退加载仓库历史工作流。

DSH 根据 Session 的当前工作目录发现项目级 Skill，同时加载用户级 Skill。项目根是包含 `.git` 的最近祖先；没有 `.git` 时就是当前 Session cwd。每任务拥有独立的根目录 cwd，任务内所有会话共享此 cwd，因此不能假定 `<Agent工作区>/.agents/skills` 总会被自动发现。默认扫描顺序如下，靠前的同名 Skill 优先（不同 preset 的同名覆盖仍按 DSH 原生 scope 规则）：

1. `<项目根>\.dsh\skills\<skill-name>\SKILL.md`
2. `<项目根>\.agents\skills\<skill-name>\SKILL.md`
3. profile 显式配置的 `customSkillDirs`
4. `%DSH_HOME%\skills\<skill-name>\SKILL.md`，`DSH_HOME` 默认是 `%USERPROFILE%\.dsh`
5. `%DSH_AGENTS_HOME%\skills\<skill-name>\SKILL.md`，`DSH_AGENTS_HOME` 默认是 `%USERPROFILE%\.agents`

给本机当前用户的 DSH 项目共享的 Skill，可安装到 `%DSH_AGENTS_HOME%\skills` 或默认 `%USERPROFILE%\.agents\skills`。只服务某个个人 Agent 的技能，配置该 Agent preset 内 `dsh-skill-filesystem` 的 `customSkillDirs` 为个人技能包的绝对目录；需要隔离时同时设 `includeDefaultRoots: false`。这些路径及正文保存在个人配置和插件仓库之外，不修改插件包。DSH 不扫描 `%USERPROFILE%\.codex\skills`。

复制时必须保留完整的 `<skill-name>` 目录，不能只复制 `SKILL.md`，因为 Skill 可能引用同目录下的 `references`、`scripts` 或其他资源。原生目录只提供名称和描述，正文在 `skill(name)` 调用后才进入对应会话。任务会话据此分派小目标，可通过 `task_delegate.skillNames` 传递相关名称；独立执行会话自行加载适用入口，再通过实际文件工具按需读取引用资料。群会话只负责路由，不加载业务技能。

Skill 不提供动作授权，不恢复固定 DAG、参数绑定、审批门槛或产物格式验收；任务会话仍负责整体完成判断。原生 loader 仅读取注册表与正文，附属脚本不会由 `skill` 自动执行。插件将所选可信 preset 中挂载的准确 `skill` 工具对象作为只读入口，后续同名替换不能继承任务会话调用许可或执行会话的只读效果分类；不要配置不受信任的 preset 插件代码。普通加载失败可纠正，不应生成未知外部写入。

验证是否真正加载时，应在任务及执行 Session JSONL 中分别确认廉价目录，以及实际 `tool/call` / 成功 `tool/result`；还应确认无关正文没有自动注入、执行能读取所需引用资料、任务和执行会话均能使用已配置的原生文件与终端工具，取消、提交和租约变化仍阻止失效动作。`test/task-session-skills-native.test.js` 使用真实 DSH registry、filesystem provider、tool-skill 和会话运行时覆盖这些边界；它不代表具体个人技能的业务效果或真实平台发布已验证。

## 安装到 DSH

2.0.0 起发行包包含任务会话架构切换。既有实例必须先按[任务会话清洁启动 Runbook](docs/ops/task-session-clean-start.md)停止旧调度、排空实际执行并审阅历史未决效果。历史版本安装方法仍见[大版本升级边界](docs/ops/npm-release.md#100-升级边界)与[更新日志](CHANGELOG.md)。


推荐让 Web、resident Runtime 和看板运行在同一个 DSH Web 进程中，避免两个进程同时写同一份 Session JSONL 和 storage domain。

全新安装使用根发行包；它会把 Assistant Runtime、Observer 看板和对应 bundle patch 一并装入 `web` profile。以 2.0.0 为例，生产或验收环境固定版本：

```powershell
dsh plugin --profile web add dingtalk-dsh-assistant@2.0.0 --save-exact
```

安装完成后必须重启 `dsh web`；仅看到依赖安装成功不代表插件 Runtime 已加载。已有 profile 升级前须先确认安装形态，不能在仍直接依赖两个内部包时只添加根包。

版本历史见 [CHANGELOG](CHANGELOG.md)，发行资产见 [GitHub Releases](https://github.com/HiQ-AI/dingtalk-dsh-assistant/releases)。设置页会通过 GitHub Release 检查新版本；“版本与更新”卡片提供可复制的升级提示词，引导先核对 profile、在途任务及[大版本升级边界](docs/ops/npm-release.md#100-升级边界)，再按[本地部署规程](docs/ops/resident-review-local-deployment.md)安全切换。根包安装与旧式双内部包安装的精确命令见[安装手册](docs/manual/install-and-configure-dsh-web.md#二安装或升级正式版本)。检查失败会明确显示错误，不会误报为最新版本。

升级后重启 DSH Web，并依次确认：profile 中的包版本、`GET http://127.0.0.1:18998/health`、设置页/运行看板、真实群消息收发。四层证据不能互相替代。

若 DSH 官方默认上下文压缩在长 Session 中出现摘要范围过小、反复压缩仍无法回到阈值的问题，可选装收敛式替换插件；安装、provider 互斥、验证和回滚步骤见[安装手册的上下文压缩接入章节](docs/manual/install-and-configure-dsh-web.md#可选接入收敛式上下文压缩插件)。该插件不随本发行包自动安装。

以下源码安装方式只用于开发未发布代码；普通安装和升级不需要克隆仓库，也不需要手工添加两个内部包。

维护者发布新版本时，先将根包、assistant 和 observer 的版本号及 `CHANGELOG.md` 更新为同一版本并合并到 `main`，再推送对应的 `v<version>` Tag。GitHub Actions 会在 Node.js 24.19.0 下重新构建、测试和打包，使用 npm Trusted Publishing（OIDC）按 observer → assistant → 根发行包的顺序发布；三个包回读一致后才创建 GitHub Release。发布 job 绑定 GitHub Environment `NPM_PUBLISH`，不再使用长期 npm publish token。首次启用和故障恢复见 [npm 发布 Runbook](docs/ops/npm-release.md)。

### 源码开发安装

#### 1. 获取源码并验证

```powershell
git clone https://github.com/HiQ-AI/dingtalk-dsh-assistant.git
Set-Location .\dingtalk-dsh-assistant
pnpm install --frozen-lockfile
node --test test/dynamic-task-store.test.js test/task-session-service-native.test.js test/task-session-http-integration.test.js
```

#### 2. 将插件加入 DSH Web profile

在 `%USERPROFILE%\.dsh\profiles\web\package.json` 中加入两个本地依赖。路径应替换为仓库的真实绝对目录：

```json
{
  "dependencies": {
    "@zzusp/dingtalk-dsh-assistant": "file:D:/path/to/dingtalk-dsh-assistant/packages/dingtalk-dsh-assistant",
    "@zzusp/dingtalk-dsh-observer": "file:D:/path/to/dingtalk-dsh-assistant/packages/dingtalk-dsh-observer"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@zzusp/dingtalk-dsh-assistant",
        "@zzusp/dingtalk-dsh-observer"
      ]
    }
  }
}
```

保留 profile 中原有的 DSH 依赖和 bundle，不要用上面的片段覆盖完整文件。

若使用 ChatGPT/Codex 订阅，再把 `dsh-codex-connect` 同时加入 `dependencies` 和 `bundles`；使用其他模型来源时保留对应 provider，不需要安装 `dsh-codex-connect`。

#### 3. 装配 resident Runtime

把 [`.dsh/profiles/resident/cordis.patch.yml`](.dsh/profiles/resident/cordis.patch.yml) 中的 resident 配置按需合并到实际使用的 Web profile patch。Web 基础 bundle 已包含 storage 相关插件，只覆盖 `storage-json` 配置并插入 `dingtalk-dsh-assistant/resident`，不要重复插入同名 storage 项。

参考 patch 不替代任务控制库初始化。首次使用须在实际 resident 配置中明确设置 `taskSessions.dbPath`、`instanceId` 与经过确认的一次性 `initialize: true`；确认初始化成功后改回 `false`。必须显式配置 `ownerActorId`、`webActorId` 及现场记录的 `ingressEpoch`；不接入旧任务库。完整配置字段与停机边界见[清洁启动 Runbook](docs/ops/task-session-clean-start.md#必填配置和时间边界)。

仓库模板有意保持以下安全默认值：

```yaml
groups: []
dws:
  enabled: false
  writesAuthorized: false
```

不要把个人群 ID、DWS profile、Agent 名称、工作目录或职责写入仓库模板；这些内容应保存在本机 DSH 配置和插件 storage 中。

### 群回复署名

Agent 设置中的可选 `replySignature` 恢复读写；profile 的 `agentReplySignature` 仅在存储未设置时初始化。留空不追加，不从名称、群职责或历史报告推断私人身份。

Host 在完成、业务提问和实质性话题回复的完整正文组装后、通知持久化前统一落款一次。确认及中间消息不追加署名；模型仅生成正文。仅清理与当前配置精确相同的独立署名段落，保护引用、代码和业务列表，不替换其他姓名。通知的 digest、发送、重试和重启恢复沿用持久化正文，配置修改只影响新通知。

群职责继续承担业务范围、授权边界和语气要求。部署后应核实 Agent 署名配置，再清理现场职责中的重复署名要求；代码修复不会自动修改现场职责或补发历史通知。详细边界见[通用 Agent 身份边界](docs/spec/generic-agent-identity.md)。

#### 4. 安装 profile 依赖

```powershell
Set-Location "$env:USERPROFILE\.dsh\profiles\web"
pnpm install --frozen-lockfile
```

#### 5. 启动 DSH Web

```powershell
Set-Location D:\path\to\dingtalk-dsh-assistant
pwsh -NoProfile -File .\scripts\start-web.ps1
```

默认 Web 地址由 DSH 提供；resident 插件监听 `127.0.0.1:18998`，允许从 `http://127.0.0.1:3080` 和 `http://localhost:3080` 两个等价的本机 Web 地址访问。通过 `GET http://127.0.0.1:18998/health` 和 `GET http://127.0.0.1:18998/state/dws-bridge` 分别检查 Runtime 与真实 DWS bridge 状态；完整判定和排障步骤见[安装手册](docs/manual/install-and-configure-dsh-web.md)。

`scripts/start-web.ps1` 使用当前用户的 `%USERPROFILE%\.dsh` 作为默认 `DSH_HOME`；若需要隔离 profile，可在启动前显式设置 `DSH_HOME`。脚本从当前项目根启动，并自动发现 `PATH` 中的 Node.js 和全局安装的 DSH。

## 首次配置与启动核验

1. 在实际 profile 中设置 Agent 工作区、Agent preset 和模型；在插件设置中维护名称/别名、群订阅及职责。个人群 ID、DWS profile、操作者身份与凭据不要提交到仓库。
2. 先按清洁启动 Runbook 初始化独立任务控制库；既有实例停稳旧执行并使用新 domain，确认 epoch 回补隔离后才开放新执行。不要用 `initialize: true` 绕过缺库或 epoch 身份不符。
3. 默认保持 `dws.enabled: false`、`dws.writesAuthorized: false`。通过隔离夹具后，分别批准真实订阅与外发；配置开关不是新业务授权。
4. 确认工作区根指引能通过 DSH 原生 `agent-instructions.projectRootMarkers` 被发现。插件不复制身份指引，也不把 Owner 提升为通用执行者。
5. 核对实际安装包、唯一进程/PID、`GET /health`、`GET /state/dws-bridge`、新任务与执行日志、重启恢复和真实消息回读。任何一层证据不能替代其余层。

启动脚本只负责启动，不证明旧工作已排空。既有 `restart-web.ps1`、`deploy-local.ps1` 及历史 maintenance/cutover 脚本可能依赖已退役接口，不能未经核对就用于这次架构切换。先执行[专用清洁启动步骤](docs/ops/task-session-clean-start.md#准备及隔离)。没有完成现场检查时，不报告部署或真实钉钉验收成功。

## 开发与测试

使用 Node.js 24+ 与锁定依赖：

```powershell
pnpm install --frozen-lockfile
node --test test/dynamic-task-store.test.js test/dynamic-execution-session-native.test.js test/task-session-persistence-native.test.js test/task-session-service-native.test.js test/task-session-http-integration.test.js test/task-filesystem-boundary-native.test.js test/task-notification-readback.test.js
```

默认运行与修改直接相关的测试。需要全量回归时运行 `pnpm test`；它限定 `test/*.test.js`，避免扫描 `docs/tmp` 中已有隔离业务仓库。保留已有 `.test-runs/` 与 `docs/tmp/` 数据。

测试覆盖真实原生 Session/preset/持久化、事务故障注入、独立进程重启、取消与动态调度，但脚本化模型、隔离平台和测试进程不能代替现场 provider、OS 沙箱、生产服务或钉钉交付验收。测试接口只在显式 `testApiEnabled` 时启用，resident 不应直接暴露公网。

历史实现与运维资料仍保留在 `docs/spec`、`docs/api` 和 `docs/ops`。遇到与本文冲突的固定工作流、阶段验收、Owner 原生工具或权限自动提升说明，以当前任务会话源码及专用清洁启动 Runbook 为准；不要据旧资料恢复已退役的写入口。

宿主 DSH 联合升级的历史验收与配置接纳证据见 [PR170 归档规程](docs/ops/dsh-unified-host-upgrade.md)及[离线续接记录](docs/acceptance/dsh-unified-upgrade/continuation.md)。这些资料保留宿主 alpha2 修复来源；本次任务数据仍执行清洁启动，不恢复旧任务迁移。

任务统筹上下文只保留一份当前Host快照：旧快照及旧版历史标记在原生请求生命周期内退出模型surface，原始审计日志不删除。短文本直接展示；历史任务正文、重复材料及完整执行结果通过contentRef按需读取。执行目录保留身份、版本、目标、状态及结果入口，终态执行不再重复附带旧阶段进度；不能仅凭目录中的成功状态宣布业务完成。当前用户来源、作者、更正和约束保留，完整来源与执行目录始终可读。

当前运行中的原执行自行消费普通工具成功/失败，不逐条唤醒统筹。阶段成果、执行结束、真实未知效果、恢复/迟到结果和用户新指令仍触发统筹；已有十分钟真实日志巡检保留。统筹按阶段判断进展，避免连续工具调用造成重复快照和空等回合；正常工具/助手历史仍由原生上下文压缩管理，本机制不保证整个长期会话总长度恒定。

模型返回已识别的上游过载或fetch failed时，不标业务blocked、不消费唤醒，按现有退避沿原统筹会话继续；已提交决定优先。旧版已误标TASK_SESSION_NO_SUBMISSION的任务，仅在原session当前lease的末尾turn/end精确证明临时模型错误、任务排空且无业务问题时补一次持久唤醒；普通配置错误不自动恢复。

任务统筹wait等待排队、运行或未排空的小目标时，看板仍归执行中；真实问题、业务阻塞或暂停归等待中。

任务统筹遇到无法自行解决的事项或授权边界时调用task_request_human，持久登记具体问题、原因、证据和已尝试动作并进入等待中。人工介入页只对当前任务待答事项开放原文答复；答复按受信Web身份留存来源，核对请求和版本后沿同任务/会话唤醒进入执行中。原群中被明确路由为该任务补充的本人答复也按相同来源核对闭环。答复仅针对申请事项，不代表无限授权或已完成验收，未知效果保护仍有效。

明确交办“部署到UAT”已包含该任务在目标UAT的实际部署，不能先做准备再申请同一发布的“最终批准”。提交、集成、构建、镜像摘要核验、目标工作负载更新和验证按既有范围持续完成；需要人工时说明尚未满足的具体条件，不能只因规则含“需批准”就忽略已经收到的批准。用户后续暂停或缩小范围仍优先，生产及数据操作等越界事项不由UAT授权推导。

执行中的会话每10分钟进行一次真实日志巡检，十分钟时钟及观察序号保存在执行账中，重启不重置。Host从当前输入/租约对应的持久会话记录提取实际事件后唤醒统筹；统筹必须调用task_execution_progress读取记录，再对照目标判断进度和方向。最多返回最新8条、每条640字符的脱敏摘录及序号/摘要，未结束调用仅给引用；不重复注入整份日志。没有新日志不证明停止，running/进程存活不证明业务推进；不自动重放或取消。人工等待和暂停不会被巡检绕过。

任务会话记录的查看不拥有任务写入权。已注册的任务/执行会话只由Host原生create/resume取得写句柄；普通会话页面仍可读取历史，但其后台激活不能抢占这些会话。未排空任务的空重试不清除原故障告警。此约束针对会话生命周期归属，不限制会话已配置的原生业务工具。

原生网页读取和搜索沿固定工具对象身份识别为只读，普通读取错误不再进入未知写效果账。旧版误记的网页读取错误通过 task_operation_reconcile 核验原调用、参数/结果摘要及同轮正常结束记录，执行已排空且无活动会话/job 才转为 failed；保留原 unknown 审计，不重放请求、不视为读取成功。原生 edit/write 的读取、版本、文件类型/大小和字面匹配前置拒绝按 Host 结构化 FS 错误码记为 failed/noEffect，保留错误与结果摘要，由原会话读取当前文件、纠正请求后继续，不因这类错误转人工。旧文件 unknown 通过同一 task_operation_reconcile 核验原生日志 data.error 错误码、精确调用与同轮正常结束证据后转 failed，保留审计，不按错误文字或当前文件内容推断原调用成功。取消、IO/权限/沙箱、未知错误及缺失真实终态仍保留未知保护。

原生工具错误若仍为未知效果，模型不能凭错误文字自行清账。操作人可在当前技术申请的本机Web回复中显式提供 `nativeFailureResolutions`（原operationId及摘要）；`POST /tasks/:taskId/human-requests/:requestId/reply/check` 零写核验原日志、正常回合结束、排空和绑定只读调查。正式reply在单个事务内记录受信来源、结算全部指定失败并答复申请，保留完整原账和 `partialEffectsPossible`，不标成功或无效果、不重放。未确认的写效果仍受unknown保护。

Web对原任务的补充、重开和取消沿已有话题继续，保留原文和独立意图收据。旧版本产生的Web重复话题可按原任务/applied关系在本机Check后归并；默认列表只展示当前话题，历史归并记录可通过includeMerged及原ID读取，不删除来源或重放动作。

任务授权连续性：统筹和执行共同核对原始有权来源及近期补充，不以最初需求人身份过滤后续操作人指令。模型输入保留原始来源和最近19条来源（总计最多20条），完整来源可按目录读取；旧摘要不能覆盖新原文。技术恢复答复不新增授权，不自动撤销既有交办；后续明确暂停、撤销、改环境仍优先。已授权的必要准备继续完成，真实最终审批先准备后提出具体缺口；未知效果及原生权限拒绝继续有效。等待说明先说进度和具体缺口，再说需要用户决定什么，技术清单放证据。

话题决策通过 `topicUpdate.summary` 维护累计摘要，供历史话题检索及后续决策使用；已处理且摘要为空的话题沿现有只读摘要请求补齐，不重新执行任务或发送群回复。

通知回读允许已核验的 DWS 顶层无序列表项间换行（包括空行）消失；不删除正文中的空格、列表标记或段落边界，不变换代码围栏内列表。仍须独立核验原发送回执、目标群、发送者和原生引用；unknown 状态只回读，不重新发送。

执行续办以 `executionId` 保留会话身份；`task_delegate.key` 是单次委派请求的幂等键。同一请求重试复用原 key 与目标，已完成后的新输入、新步骤使用新的稳定请求 key，并保留原 executionId。相同 key 改目标仍拒绝；不得通过换 key 绕过未知操作保护或重放已完成动作。

本机桌面重启入口与零写入预检见[任务会话启动说明](docs/ops/task-session-clean-start.md#本机桌面重启入口)。
