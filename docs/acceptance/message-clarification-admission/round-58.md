# 第58轮：清理回读与部署前配置核验

用户已授权清理清单中的10个旧验证依赖缓存，执行工具仍拒绝删除；本轮实际清理由用户本地PowerShell执行。独立只读回读证明10个目录均不存在，对应源码package.json和yarn.lock的SHA256均未变化。证据为私有 `docs/tmp/five-cache-independent-readback.json`：`total=10`、`remaining=0`、`sourceHashChanges=0`，回读时D盘空闲6,292,656,128字节。

47665056包的正式部署Check通过，101文件已核对，所需空间2,772,231,325字节，小于当时可用4,843,970,560字节。maintenance 506已正式封存，原PID146216已停止。部署仍在数据副本校验阶段；本轮不把停机、包检查或配置Check记作安装/业务完成。

第二轮配置输入通过原生编辑器零写核验，profile独立回读SHA未变。SG20的冻结scope来自原Run注册定义的config.input，其摘要f0c20e与实际选择逻辑一致；不得误换成Task原需求工件摘要。保留双仓库原有localAcceptance，新增本任务精确scope，单次场景保留七项UI覆盖及backendVerified=false。

SG18/SG22 Host诊断事件仅准备提案，readyToEmit=false。须独立核对安装能力、配置收据、原Task/Owner/Run/来源版本后，沿原生task.owner.event提交；未提交新事件或阶段，未伪造用户补充或授权。

部署后续已闭环：schema8→9迁移收据verified=true，逐表baseline保持；包47665056安装101文件核验通过，profile由2032967c变为3fd05828。首次计划任务启动实际退出1，日志安全提取仅记录platform_local_credentials_unavailable；当前Kubernetes/GitHub/Docker原生读取均独立通过。核对无Web进程、原包/profile未变及离线迁移baseline后只重启该精确计划任务，没有重新安装或迁移。正式Readback ready=true，PID39124双端口；Resume之后maintenance507 inactive，自启启用，health=ok、inboundProcessing=true、bridgeHealthy=true、recoveryIssueCount=0。证据在本轮私有部署目录的stopped-start-retry-check.json、stopped-start-retry.json、readback-after-retry.log、resume.log、live-independent-readback.json。

SG19沿原Task重评event407被接受，Owner已从pending进入running（revision34/lease11）。这是执行推进证据，不是最终业务完成。用户质疑校验耗时后确认：仅29MB控制库索引迁移不需1.69GB历史Task备份；旧helper在Readback/Resume之前还重复全树容量扫描，同因修订正在实施。

## SG19：历史查询证据不因本轮未重读而被拒绝

仅修改 task-owner-controller.js：有 Host authorizeCompletion 时移除临时 readArtifacts Map 的重复门禁；无 Host 保持原门禁。领域拒绝诊断仅额外接受 input.queryEvidence 中经 readTaskEvidence 核验的当前 Task/需求证据。未改业务验收、未自动 complete 或现场写账。

实跑：workflow-service.test.js 新增完整 drive→Host 验收 6/6 PASS（8456.6ms），覆盖同原生会话前轮已读旧引用、实际验收不满足、合法领域拒绝诊断、外来引用、旧版本引用和工件真实丢失。日志 docs/tmp/clarification-tests/owner-known-evidence-final.log。第一次夹具把普通验收拒绝误当领域诊断，4/5；拆开两个真实路径后 6/6，原日志 owner-known-evidence-first.log 保留。

关联回归 task-owner-session-native、task-owner-delivery-manifest、task-general-workflow 共 69/69 PASS（15031.9ms），日志 owner-known-evidence-regression.log。持久登记 Task/版本/租约隔离定向 1/1 PASS（261.2ms），日志 owner-known-evidence-store.log。

额外 scope 组合 5/6 PASS：查询在途 pause/cancel/requirement 三项及真实查询+前序执行组合验收两项通过；既有“授权投影修复后同Task同Owner按新需求查询”在 workflow-service.test.js:5404 observed.length 期望2实际1。该例只提交 wait、不执行本次 complete 分支，但尚未独立确认基线，不能声明其已排除；日志 owner-known-evidence-scope.log 保留，未扩范围修改。

上述授权投影失败已补独立基线验证：当前单例 1/1 FAIL（1196ms），git archive c4a69f5 隔离检出同一测试亦 1/1 FAIL（1789ms），均在5404得到 observed.length 1 != 2。隔离目录 docs/tmp/owner-evidence-baseline-c4a69f5，仅逐个链接第三方依赖真实目录，不链接workspace源码或整个node_modules；首次缺pg的环境失败单独保留，依赖补齐后实际断言与当前一致。日志 owner-authorization-projection-isolated.log、owner-authorization-projection-baseline-deps.log。该失败已证实基线存在，非本次完成证据门禁新增；未修改它或冻结源码。
