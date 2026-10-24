# 第九轮：正式团队统一产物与真实串行续办

用户纠正：整个团队统一任务产物目录，禁止分散fixture或根外业务产物。尚未执行业务恢复；所有ASSERT目前NOT_RUN，状态以matrix.csv为准。
现摘要修复已受控部署至PID94952；ACL3原Task根WO已精确修复，旧失败/消息/任务均保留。
本轮需在正式共同outputs根中证明A/B/C同一访问边界，shell/nativeFS根内成功与根外写拒绝、正式完成事件自然续办、nonce/原字节SHA消费及最终群回读。

## Native统一边界实证
- 使用正式policy补丁候选+真实dsh-sandbox/fs-sandbox/sandbox-local/pwsh-sandbox组Context，3Session共享同一artifactRoot且header.cwd不变；FS根内写/跨团队根外写拒绝；PowerShell根内写/根外写拒绝；B/C跨Task读取A文件通过；改变绑定拒绝。PASS日志docs/tmp/coordinator-abc-validation/round-9/native-policy-check-pass.log。
- 首次临时目录测试失败是因为临时区被sandbox额外允许且测试脚本错误读取shell结果对象，未作为通过依据；改用非临时D:/dsh_home/workflows/runtime-v2/local-acceptance/artifact-native-proof-1独立测试根重跑通过。该测试根无业务ABC产物，后续清理需按普通测试tmp规则盘点，不得删除历史业务证据。

## 正式policy扩展候选
- 由于用户要求团队统一产物根且禁止分散fixture，lead按原生安装模式生成dsh-sandbox-policy精确补丁候选version0.2.1-rc.2.artifact.1；不改session.header.cwd、保留shell/FS同一policy mode，新增持久session projection sandbox/artifact-root + bindArtifactRoot，per-call拒绝junction/路径重绑定/绑定scope危险模式。
- v2候选entry SHA8f47164d58f007c0d06a619c98cae424bf188ca4ef3f45078c5731c6da074984；真实native Context+session+FS sandbox+PowerShell provider实跑PASS：三session同根、根内读写、根外FS/shell拒绝、跨Task读取、重绑定拒绝、danger模式禁止。日志native-policy-v2-pass.log。
- 当前policy候选仅本地未安装；下一步为唯一proposal/manifest CAS、Task原生部署脚本Check→正式安装→Readback/Verify。

## 修复集成与测试
- 新增受信原A人工reply/check的artifactScopeCorrection结构：客户端仅coordID/expectedRevision/reason，Host派生正式root，domain同事务记录coordination纠正source/history，不改原Task身份/目标版本/requirements历史/依赖/完成；全队scope携带同一已认证纠正sourceId/actor/reason/time。
- 单独原生2用例已实际PASS0skip（env MODULE/ENTRY一度命名不一致导致2skip，已补跑，不计为通过）；相关8文件104PASS/0FAIL/0SKIP，日志related-final-regression.log。
- 新增4个测试文件已全部release=true映射，node scripts/test-suites update/check=307files/historical3/deleted0；没有运行CI或无关全量。
- SDKpolicy持久tgz330a71b210480dcdb2d1de03f38593bf9556b0ddf0bac862ef4878922c15e156，提案Check writes0；尚未安装。当前Host仍summary-only PID94952。正式团队outputs空目录已建，先Check再仅当前owner WO修复，独立afterCheck所有必要权位true，无业务文件。

## 冻结候选与部署预检
- Assistant统一root实现tgz013ac10fdb97b2a0520a427db3d73c9872a1518eb4696de825ee279f4897c6f9；policytgz330a71b210480dcdb2d1de03f38593bf9556b0ddf0bac862ef4878922c15e156，Observer原包不变。
- Native部署Check通过：signals0/writes0/quiescent=true/drained=true/unknown0，现PID94952/profileSHA74fe...；正式执行后台进行。
- 受影响组合104PASS/0FAIL/0SKIP；既有independent-coordination-native夹具曾向公共summary/evidence输出内部短TaskID，触发GROUP_REPLY_INTERNAL_DETAILS。只修正夹具公共业务文案（未改身份/依赖/事件/次数断言、不改生产guard）后单文件17/17通过；完整组合再跑中。
- 真实fixture同样有内部ID/含coordID绝对路径公开冲突：原目标核对ID/路径在本机证据和共同root内c.md完成，群通知遵守既有内部编号保护，仅公开run标签/nonce/total/SHA/文件名；不关门禁、不把公开输出失败冒充协调完成。将通过原A正式技术答复提供该边界澄清。

## 真实E2E结果
- 原A/B/C均completed；events sequence5(A),6(B),7(C)。B trigger.eventId=A completed event；C trigger.eventId=B completed event；B/C均自动claim，无人工start/continue。
- 原A恢复前operations/executions/events=0；正式reply只写受信artifactScopeCorrection/history，Task identity/versions不变。
- Native工具证据：A运行时随机nonce+CreateNew a.json+read；B readA+重算SHA/total+write/readB；C readA/B+独立重算+write/readC。
- 统一root文件独立回读：a156B SHA b7838e...af99；b178B SHA11202f...c8db；c.md1884B SHA2917ae...6929。nonce一致e994bf...566e,total81。根外业务文件零。
- DWS final mget complete=true/found3/fail0，仅测试群；C final message msgt7ZSZOaRko7X/Ds+dvxwKA==，summary corrected msg8S6...为旧阻塞前状态，最终summary msgoiajQr7RaLQlyYIfz2en1g==。
- Health after deploy PID84680=ok/recoveryIssueCount0/inbound true；Assistant013ac10f...、policyartifact.2、Observer原包/profile/PTY overrides独立核验。
- Claim switch latency A→B5.298s/B→C3.600s；first native tools not switch bound.

## 部署失败与安全续接（保留）
- 正式原生部署初次在install阶段失败，原PID94952已退出/自启禁用/原账排空，未启动部分安装。根因明确为本地policy补丁未同时声明root直接file依赖，pnpm尝试从registry取未发布artifact.1版本。
- 修精确安装合同：只对policy一个包同时写direct file dependency与override，保留其他依赖/PTY overrides；CAS Check/Apply与真实tgz/hash核验通过。保留原失败目录，没有改旧收据伪造成功。
- 原生恢复测试发现新增非released事件sandbox/artifact-root不能恢复；修为artifact.2正式包，在已发布sandbox/mode事件中携带完整artifactRoot绑定，独立projection保留。没有放宽日志白名单或把安全状态设为ignorable。
- artifact.2 tgz SHA9b4d2969577061b9e376bcca155027e450a760ea0a4208cf3015e385a998a78f，entry225d0fbdb82dc459dcfadcc1834b821305576e19b176e5199fe090cd789019af。原生CLI接续安装通过；启动前独立verify真实consumer/Assistant68files/profile未变、离线ledger排空后恢复原计划任务，PID84680。
- 当前health=ok/recoveryIssueCount0；profile patchSHA74fe100c...保持，当前profile manifestSHAe65b79fe...只必要policy/direct包spec与此次Assistant源变化，原Observer与PTY overrides保留。
## 最终分层验证
- 仓库隔离native profile默认按已审阅原native entrySHA构建同一policy recipe，不依赖用户profile、凭据或env跳过；native3场景全部PASS0skip，覆盖Owner+Execution根内/根外与自然ABC。
- 最终发行烟测真实冻结Assistanttgz：14PASS/0FAIL/0SKIP，包含实际解包/运行/health，日志final-release-smoke.log。受影响组合最终日志isolated-related-final.log，状态由完整末尾回读记录。
- 原始failure/超时/环境错误日志均保留，不加总重叠测试计数、不用mock/CI替代群E2E。

## 最终独立复核与完整结果
- contract-worker独立只读原库确认三Task原身份/版本1/1/0/1、三completion5/6/7、B/Ctrigger父event匹配；wake账仅A一次human.responded，B/C只有协调task.created，未人工启动。
- evidence-worker独立Node断言共同根文件集合精确a/b/c、nonce/total/SHA/完整路径匹配，独立DWS mget final3/3及当前health ok/0issues/real/inbound true；旧误导摘要保留历史，新摘要和最终通知正确。
- 最终隔离组合122PASS/0FAIL/0SKIP（99.915秒），发行smoke14PASS/0FAIL/0SKIP（45.737秒），文件映射307/historical3/deleted0。无CI/无无关全量。
- A完成00:31:33.660，Bclaim00:31:38.958，B完成00:32:41.425，Cclaim00:32:45.025，C完成00:35:04.926（北京时间2026-10-25）。C最终群通知00:35:07，协调摘要00:35:10。
- 入口前置耗时原轮69.086秒到安排/70.255秒到A首认领，包含未拆分路由/规划；不据此归因单层。原A修复恢复认领00:30:37.720→最终C完成267.206秒；人工修复/部署等待不算运行时业务执行。
- 声称PASS仅指本指定真实场景；不证明所有周期/取消/外部CLI执行合同。当前外部CLI团队scope明确拒绝；C用了额外只读账本探索造成约90.934秒到首产物工具，未改性能机制。
