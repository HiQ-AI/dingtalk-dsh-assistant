# 第 29 轮：继续真实开发与提测闭环

日期：2026-09-26。状态：执行中，不能作为全链通过报告。

## 本轮要求

用户要求持续执行直到两个任务的完整开发、专属业务验收、UAT 合并与精确版本部署验证完成。沿用后端 UAT3、前端 UAT2，复用原开发分支和唯一原 PR，报告仅留本机 Web。

## 已观察事实

- 原 PR 均 OPEN、base=main。独立请求及只读观测放在 `docs/tmp/sg15-rerun-requests/`，尚未发送。
- 目标 UAT 与旧开发分支已经分叉：后端 ahead90/behind93，前端 ahead1/behind413。直接验证旧开发 head 不能证明最终合并树。
- 前端原生 `git merge-tree --write-tree` 实跑产生 `DatasetReview.vue` 文本冲突，不能自动选择 ours/theirs 丢弃另一侧功能。
- 前端审核单 `e2e-app-i18n-001` 的真实模板为空，旧脚本直接寻找预设意见框不成立；已改为真实 UI 添加自定义维度后填写。
- 在原候选依赖 Vue 2.7.16 上实跑 `$refs` computed 最小反例：初次 false，设置真实形状的 ref 并 nextTick 后仍 false。该反例证明旧保存按钮实现的响应性风险，不代替页面验收。最新 UAT2 已有面板内独立草稿机制，合并需保留最新实现并实测。
- 本地准备工具现接受显式配置 UAT1～9 且要求任务环境完全一致，环境不符在命令执行前拒绝。相关工具及评审准入测试 7/7 PASS。
- 第一次、第二次前端验收使用独立候选和不变脚本快照。第二次增加脱敏阶段记录、进程级 D 盘 TEMP/TMP，正在运行；后续固定工具已加入页面结构计数及失败截图。

## 待闭环

- v13：先在受管独立目录同步冻结 UAT 树、处理明确文本冲突，以双父提交保存开发分支历史；本地实际测试树必须等于远程合并树。
- 原 PR 通过原任务成功效果账追溯并精确复用，目标/提交/身份变化须阻断；GitHub edit 缺少服务端原子 CAS，必须独立前后回读。
- 后端通知链已定位并从线上镜像提取源码验证：消费者仅更新同 ID 源行，删除源行后不能重建；审计/队列/provider 日志保留。专属 fixture 与精确清理正在实施，仍未写入测试业务数据。
- 正式受信场景配置、部署新编排、真实接纳两任务、验收与合并/部署尚未完成。

## 空间限制

C 盘无剩余空间，当前新进程使用 D 盘专属临时目录。对已停止的首轮候选 `node_modules` 完成路径和进程零占用检查后，删除命令被自动审批拒绝，未执行或换方式重试；验收与源码文件全部保留。

## 正式重执行与故障回读

- v13 安装包 SHA256：B83E50936A8FF18CA33FC2E039269F4C65B32F1AEC6884DCC58D91DB933FCF27，81 个文件一致；启动 PID14864。计划任务更新因空间不足失败，使用原启动脚本及 D 盘 TEMP/TMP 直接启动。Web/control 可用，钉钉消费者异常，整体健康 degraded。
- 正式接纳后端 task-web-b99f707d7f645fd7833282e2c2a8d05c181ab069602b9d9adeeab7ca425fb69b（UAT3）、前端 task-web-d0cb11ee3c402960248b4ebfb2e40ca8b8e5567eed55573bc2988059e425da3a（UAT2）。初始 Owner 无决策已自动恢复，三阶段计划均被接纳。
- 两项均在 prepare-workspace 执行后映射 inspect-and-propose 输入时失败：Cannot read properties of undefined (reading 'requirement')。Direct 工厂替换节点丢失 prepare-generation 依赖，Deliverable 包装器却读取该依赖；v13 只补 workspace 依赖。静态节点测试遗漏了真实 controller 的依赖投影。
- 经正式 cancel 接口取消这两个失败重执行。独立只读 SQLite 回查两个 task_controls 均 cancelled、无非终态 execution_runs、无未决 execution_effects、无 running owner。页面仍显示 waiting 的取消投影问题同步修复。未修改原任务、业务源码或远程 PR。
- 保留 v13 冻结定义，新 v14 增加明确依赖并新增 controller 串行回归；取消记录保留，部署后从原任务使用新 requestId 重执行。未修改活动数据库。
- 第二次前端旧候选验收已结束：fill-opinion/BROWSER_TIMEOUT，数据/浏览器/会话/双服务清理通过；结果不视为业务通过。新场景使用 UI 添加自定义维度。

- v14 新增控制器回归：v13 实际复现相同依赖错误；v14 同一受管 Git 夹具顺序进入方案、校验、应用，核对真实文件 old→new，并验证准备节点派生的本轮要求被传给下游。round6 日志 1/1 PASS；registry/proof 定向 6/6 PASS。最终打包还等待取消调度及投影回归。

- v14正式部署完成：包55198AED9CC3201C11F44BD794415F4FE56F8A2D8F0825CD967FE110E2C9A2B7；PID13880，81文件匹配。安装后认证Web200、恢复问题0、旧73任务身份状态不变、两取消任务outcome cancelled。health degraded/inbound false，未宣称钉钉恢复。证据 docs/tmp/uat-integration-deploy-20260926/v14/。

## v14 正式任务

- dataset：task-web-eef13ea07fe7ef7eeb00df717e6a06eb61dc5d1d15382a998094e9a1755cf1da；工程 run-fcfcafcb5f72d356dfca5aac311cd549c63bffb0a1c109ce85927ee7a5f2c1ac。
- dataset-web：task-web-5e8a34a77a459c9fba3124053d91accea81b327eceda3bbdb26e77817a898d09；工程 run-94ec1c5c2841240519c687f5ae5e9b4d730b2302f2e26d0796244f34d22ca144。
- 控制账独立回读 definitionVersion=14，两项 dev 分支、taskBase、UAT targetCommit 均与原任务及指定环境相符。两项 prepare-workspace 均 succeeded，真实进入 inspect-and-propose，原输入映射故障已越过；尚不等于完整业务链通过。
- 最终新增依赖/派生要求回归4/4，registry6/6；取消Owner15/15、任务计划21/21、Web取消2/2、UAT9/9、engineering10/10通过。扩展组初次唯一失败为旧v4迁移夹具未补v5，已按实际v5迁移路径修正并重跑21/21。生产迁移未改动。

## 后端本地验收准备失败

- 后端候选697bf8b53b927c8420f57ec5f4e6e21dd0f3e598aca11bf620ebe3f6a2377f2d构建通过，但模型方案只给部分后台开关修改，明确承认未完成。已通过正式context补充完成七个条件Bean与BlacklistCacheService的要求。
- runner identity365cc3de9b2d30868f489153bf6c0e7c9c43845b0d8840ecf9ce733eeda907c5在prepare阶段2.365秒失败，未启动服务、未运行业务cases。cleanup因merge ledger尚未初始化失败；原回执与失败工件保留，不标业务通过。
- 另发现merge verify-cleanup的mode=merge-normalization不符合runner只读特判；修复为准备前initialize资源账，以及按通用namespace/empty合同回读，不伪称read-only。
- 原生效果external-d08db79d462bc9538faf842feca5131e27aa5d2df4fc7963d482f1a80707f240保持unknown，正式cancel处于cancelling。后续必须实时只读对账、通过原生delivery.reconcile确认为failed，不能SQL强制解锁或改原receipt。
- facts_store独立只读确认namespace acceptance-365cc3de9b2d30868f489153bf6c0e7c 的结果及-A/-B过程0条，Redis匹配snapshot0条；没有补账或写入。
- 质量报告同源风险：使用ledger唯一UUID作两来源及结果data_attribution，不创建datasource实体；当前UAT3 preview/confirm支持不存在实体，后台报告只遍历已有实体。实际执行需在admin库读回ID不存在、editor质量报告前后为0，再清理精确业务行与snapshot。
- UAT现有cron成功/失败都自动钉钉通知且无静音开关。通过正式context要求两任务在通知授权或受信静音证据前不派发UAT合并/部署，开发及本地验收继续。尚未触发任何远程提测。

### 本轮恢复后的实测与当前阻点

- 前端 v14 构建结束，失败于 `DatasetReview.vue:131:43 padded-blocks`；尚未进入业务验收。正式 context 接纳后 Owner 仍只输出 wait。源码与控制账证实缺少失败工程阶段的正式修复动作，方案见 `docs/spec/task-engineering-failure-repair.md`，正在实施同 Run 新代修复。
- 后端原准备失败事件只读对账再次通过：三项精确名称业务数据 0、Redis 快照 0、候选进程/监听 0，原 receipt 哈希未变。未 execute 对账，原失败证据保留。
- 新 merge 工具实际运行唯一命名空间 `acceptance-ed07027cabb741bfb244fb1865ac4bf7` 的 initialize、cleanup、verify-cleanup 全部成功；仅本地账本初始化，远程只读核对，包括 admin 数据源与质量报告为零。证据 `docs/tmp/merge-zero-business-probe.json`。这不是业务合并验收通过。
- 新工具已冻结为 `tools/e086f58299cd4f674283b14913b777c3dc8c36bc93958207efe23c5d1f3c2e90`，bundle `tasks-45fba4ea387bb700.json`；未激活，当前在线仍 v14 旧工具配置。
- 原生单次对账已经 execute 并独立只读确认：`external-d08db79d...` 为 failed、resource holds=0、历史观察从1追加为2；原receipt SHA仍为eb8e32eec1eb9561a659ced08c77cde45381ace250f82a73b58ba5a7979f1af0。备份 `D:/dsh_home/workflows/runtime-v2/control.sqlite.pre-prepare-failure-9a1b1dcf-08e6-49a9-9a59-6a622e24cc67.sqlite` 67,145,728字节。实例已停止，待修复版受控部署；不标记业务通过。
- 新配置零写CAS检查通过：原profile 2c3af4dd...，预期新profile 97579322...，当前尚未apply。两PR独立gh回读仍OPEN/main/原head。
- 最终清理复审发现并修复共享文档误删反例：逐行校验子资源归属，拒绝namespace外过程引用文档/UUID或外部data引用core。17/17定向测试通过，真实空资源initialize/cleanup/verify再次通过（namespace acceptance-f402ece0e3c54e22af5bdb8d020629b1）。最终工具hash d98ac501...，新bundle tasks-7b12c223e92c09b8，替代未激活的tasks-45f...；未覆盖历史bundle。
- 修复包0657375a2ad19b502884ca2aa6e812a364a84646a3b82b180a13f05f2f86f010已部署；备份D:/dsh_home/backups/owner-repair-20260927-003153-000，新PID51424，82包文件匹配，认证Web200，恢复问题0，钉钉仍degraded/inboundfalse。任务77项，9个业务Task、40旧节点、7终态Run及68legacy记录身份/历史核对通过。计划任务定义未变。
- 配置已切换tasks-7b12c223e92c09b8，profile hash ffe53c89119ab0fc4eb12c48c7dc309b9f883d3207e200411f80f1304b7cbd74，独立check changed=false。
- 前端Owner真实repair.accepted记录已产生：同run-94ec...由generation1进入2，旧失败证据保留；已进入apply-changes。后端旧eef13...取消收口，新task-web-77c3a3792c6d00e75b99ea43c6b629f8b71f858b0076c8d8b8bfd931049923e9已接纳。首次Owner混淆规划/执行只提交一个阶段，命中精确三阶段授权门禁；正式context澄清后已advance，进入prepare-generation，无需放宽授权代码。
- 前端第二代进入build后，独立实跑当前候选三项专项回归共16项，14通过/2失败：旧父页面saveDraft文本断言、旧指纹不匹配即删除断言。日志docs/tmp/frontend-draft-regression.log。这是现有Host只build漏测，不将构建或UI单场景代替专项回归。
- 已通过正式cancel将前端task5e8a...收口cancelled，保留两代历史与真实Owner repair证据。准备在原Host检查同一steps（依赖安装后、build前）加入固定三项Node专项测试；当前Run检查已冻结，禁止热改。待后端当前执行安全排空后更新配置再正式从原前端任务重执行，复用原开发分支/PR。
- 后端task77c...本轮方案已包含全部八处后台模式与MergePreviewCalculator修改，正在构建；未手工修改业务源码。

## 当前后端真实候选进展

- 后端run-e018d22b1f8a07620ea984c02dcdd49af3f4bfd8fcc78300ed48e87d30028360构建通过，候选0ec688047ce59e238e34e7ea32729b9da32e0696fb41042c4129d18a2aeb8eb5。
- 在实际构建目录verify-tz1q0M，构建结束后以现有Java11/Maven3.9.6直接运行Surefire2.22.2的MergePreviewCalculatorTest及MergeWeightAllocatorTest；22/22通过，无failure/error/skipped。独立回读两份XML为16+6。证据docs/tmp/backend-pure-calculation-tests.log及backend-pure-calculation-readback.json。未启动Spring/共享业务，作为额外单测证据，不代替业务场景。
- 真实本地验收已开始：identity bd1e2cd5219b1f1737c6522cfa61e978698faa513696412aacf3c1f98f7a229e，plan a99697f1edf5ed10678a2d9e50c50a90473b86bb8df3b25b848a0e7291bb466e，effect external-1f9b8ec760923c9687e79ae096e0e2ba37c6065039513fae70f027ba21a432fe 执行中，尚无业务结果。

## 后端验收通过及前端检查补齐

- 后端 identity bd1e2cd5219b1f1737c6522cfa61e978698faa513696412aacf3c1f98f7a229e 实际业务回执 passed=true：两个0.5 kg来源、声明单位t、权重和1，最终合并1 t且已持久化；dataCleaned/processStopped均true。另一次只读verify-cleanup独立确认empty/dataCleaned=true。
- 原PR #371已独立回读OPEN，目标feature/uat3-base，head81e6a99f760205f04396888e79b5da47fac7f88e，仍复用原开发分支。prepare-push一次远端读取失败由现有恢复机制重试成功；没有放宽分支或提交门禁。当前stage-2 waiting_confirmation，未远程合并或部署。
- 前端Host检查现固定依赖安装→三份Node专项回归→生产构建。配置脚本2/2通过，离线排空CAS更新后profile SHA5c307c36ced5359c4e2b823804a53b8072476521375fa4becb1c49dd0e95818b；新PID29948，认证Web200/恢复问题0，10业务Task、58旧节点、10终态Run、68legacy不变，监听仍degraded。
- 正式从原前端任务接纳新task-web-284f69f2fb3d6389703292b5b36bf4a7b80c334d0e4b2eb0e18500255a76b366，run-18a618d6521de1cb7eaddf29c6d56c637084bde3f4419d2538f13679f463aab4。完整三阶段计划已接纳，现inspect-and-propose；尚未业务通过。
- 发现Web来源没有正式阶段确认入口；已有IM确认复用native CAS。正在补最小Web确认接口、耐久审计和版本反例，不通过离线写库绕过确认。UAT流水线自动钉钉通知授权仍待用户答复。

- 前端新方案在apply-changes明确失败ENGINEERING_PATCH_AMBIGUOUS：第2个替换项仅含冲突结束标记，原文件匹配2处。Host先在内存还原全文件再写，当前原工作区无部分应用。现恢复定时器重复同方案，缺正式方案失败修复路径；按原同Run新代修复补充该精确错误，不放宽唯一匹配门禁。
- Web阶段确认接口已实现，主代理独立实际HTTP/service测试1/1通过；control账21/21通过（代理）。绑定当前stage/output及四个版本，重复幂等/过期/未来阶段/跨任务/伪造actor反例通过。仍未实际确认或触发远程UAT。

## 正式阶段确认与歧义方案恢复部署

- Web confirm-stage及stageConfirmation只读绑定完成；主代理最终真实service/HTTP组合2/2通过，阶段控制21/21通过。歧义方案同Run第二代真实Owner/Controller2/2及旧文件漂移专项通过，精确apply-changes+ENGINEERING_PATCH_AMBIGUOUS不再重复recover。
- 部署包4b19c3ee52d9f5d834fee3f2b0b6c95ce2495bce4e88d589667bd831fac64ddf，82安装文件逐一一致。备份D:/dsh_home/backups/owner-repair-20260927-013843-091；新PID25576/launcher51296，profile5c307c36...保持，11业务任务、58旧节点、10终态run和68legacy核对不变。部署工具真实排空保护拦截两次未停实例，随后排空更新成功；活动日志只记元信息，避免占用hash导致回读误报，脚本反例5/5。证据docs/tmp/stage-confirm-repair-deploy-20260927-2。
- 前端真实engineering.repair.accepted seq3746，原run-18a618... generation1→2，contextRef sha256-c27091b330c96cea54eba94e11af7970488734a7c161254a130be8305a194e48.json；无手工改业务代码/控制库，现第二代inspect-and-propose会话10d4d6e7-c299-4f82-81c4-78ffc599efbb。
- health恢复问题0，钉钉仍degraded/inboundfalse；3080启动URL与Bearer探测401，正在只读核对HTTP层认证，不将端口监听冒充认证Web成功。UAT通知授权仍待用户，未确认提测阶段。

- HTTP认证已正确闭环：launch token首次GET返回303与signed cookie，随后仅内存携CookieGET200且HTML=true。此前自动fetch不持Cookie导致401；非实例故障。证据web-auth-readback.json，不落盘凭据。
- 前端第2代apply-changes已succeeded，proposal sha256-fa721d9ae3031c45385de295a8fb68157977f6a8966291c89a06e52eb47887db.json，工作区ws-8c7dd28fd04a399c73d9f0a938f5506e20d4fac7b3653e71897dceb4138acf89，候选检查目录verify-QVz1Qb；仍在检查中，未声明专项测试/构建/业务通过。

- 前端第2代正式Host检查通过：Node22三项专项17/17，依赖198383ms、测试236ms、生产构建898460ms，整体1097080ms/exit0。候选0adf1115308b7f44433bbc7d48e3fd1fc72dda61ae56bb25e8466a15c9d60bc0、tree2a422484e08aee36dbbf809713e4211af47b0f38。真实本地验收identity edea00d9c00799ee1e8592b5c3706ddbf1f595c2a8ced844c947af076c010a51已开始，未有最终业务结果。

- 前端验收prepare-web真实215.28秒/无error完成，serve-web PID24364于02:09:26开始；尚无最终receipt，不标业务通过。D盘约1GB余量，未清理文件；C盘仍满。

## 前端真实业务通过，交付预算阻塞

- 前端identity edea00d9... passed=true：saved/restored/browserStorageCleared全部true。prepare219409ms、依赖后端启动88078ms、前端启动985378ms、业务29307ms，全部清理阶段成功，createdResources=0（仅浏览器草稿）、dataCleaned/processStopped=true。主代理独立回读50118/62787监听0、前端PID24364已退出。证据docs/tmp/frontend-generation2-acceptance-readback.json。
- 当前在prepare-commit命中EXECUTION_BUDGET_EXHAUSTED；只读控制账claim_count=max_claims=54，generation2/revision1。尚未创建提交或更新PR#368，原验收通过证据保留。正在核对预算账与正式恢复方案，不SQL改计数、不套用历史index-budget专用命令。

## 正式预算续行完成，部署受磁盘空间阻断

- 累计领取账：第一代43次（apply-changes34次，含33次无效重复），第二代11次，共54次。正式Web continue-budget绑定任务/计划/运行/代际/节点/预算，仅当前已排空且无未知效果的预算等待可用；Host按剩余节点×3增额，同Run最多一次，保留旧计数、候选、已成功节点与失败领取回执。
- 主代理独立实跑预算真实HTTP/Controller及歧义恢复入口2/2通过，日志docs/tmp/budget-continuation-root-tests.log。隔离实测54/54→54/75→61/75，业务验收执行一次，下一阶段仍waiting_confirmation；幂等、失效绑定、恶意Origin/actor/额度和unknown效果反例通过。未对真实控制库续行。
- 包docs/tmp/budget-continuation-package-20260927/zzusp-dingtalk-dsh-assistant-0.5.15.tgz，SHA256 db5b59c309a17f9b75561e622bdb93d5fbf51e621cbc2fa721a6b64ecfaf6642。部署脚本-Check零写预检失败：D盘可用1044217856、所需1652708199字节。未停止实例、未安装新包、未删除或移动文件；已向用户说明需释放D盘空间。C盘仍满。
- 当前health只读回查degraded、inboundProcessing=false、recoveryIssueCount=0。远程UAT通知授权仍待答；两项UAT合并及部署未执行，不标全链通过。
