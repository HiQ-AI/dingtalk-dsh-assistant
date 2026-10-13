# DSH Web 与现有插件统一升级

本规程用于已有Web profile的DSH0.2.1-alpha.2与钉钉、Codex、Convergent、Bytebase联合切换，市场不在范围。不是npm稳定版承诺；Codex及早期会话迁移边使用有来源/源码补丁/本机验证的本地修改包，不能与registry同版本混淆。

## 前提与输入

先读取唯一[升级目标](../acceptance/dsh-unified-upgrade/goal.md)及[当前验收矩阵](../acceptance/dsh-unified-upgrade/matrix.csv)。所有组件类型/构建/定向测试、完整隔离Web与provider/preset加载、现场日志副本只读及代表写后重开均须通过。已有v0业务身份事件不能靠官方V3样本通过推断；未知事件与恶形身份必须拒绝，原v0字节保留。真实模型请求/钉钉发送单独记录。

升级提案在仓库外或docs/tmp保存，不提交真实配置和凭据。输入包含原package.json/patch SHA256、完整精确依赖声明及只追加的完整preset patch。保持metadata/bundle列表、模型与搜索、业务资源和数据路径；旧宿主file override移除，host直接依赖同一版本。自定义preset应基于原完整plugins保留各自配置，不能以模板抹掉。

所有tgz放持久DSH_HOME/packages，文件名包含本轮hash，独立检查bytes和SHA256。Host升级helper只允许明确的v0→1、v1→2、v2→3、v3→4迁移包file override；校验tar名称/精确版本/主入口、冻结文件hash，安装后从真实依赖解析路径比对入口字节。没有版本豁免。

## 执行

采用[原维护部署规程](resident-review-local-deployment.md)的既有编排。参数在真实提案及包路径确定后生成，示例占位不可直接运行：

```powershell
$env:DSH_HOME = 'D:/dsh_home'
$deploymentArguments = @{
  Package = '<Assistant包绝对路径>'
  ExpectedPackageSha256 = '<Assistant SHA256>'
  ObserverPackage = '<Observer包绝对路径>'
  ExpectedObserverPackageSha256 = '<Observer SHA256>'
  ExpectedProfileSha256 = '<原patch SHA256>'
  HostUpgradeProposal = '<提案绝对JSON路径>'
  EvidenceDirectory = '<本轮全新本机证据目录>'
}
& docs/acceptance/topic-context-completeness/scripts/deploy-owner-repair.ps1 @deploymentArguments -Check
& docs/acceptance/topic-context-completeness/scripts/deploy-owner-repair.ps1 @deploymentArguments -HoldMaintenance
```

Check必须writes=0，通过后才执行。HoldMaintenance启动后保留维护供联合验证；脚本既有排空、seal许可、精确旧PID停止、独占owner锁、新manifest/patch CAS、原生安装、释放锁、新进程启动与旧Task/Run回读不能跳过。安装失败保持停机；运行回读失败保持维护，不反复启动或改写许可。Resume使用原部署记录与原输入冻结，先按该脚本Readback得到ready再Resume。

## 核验与回退边界

回读包/版本、全部依赖树、四个迁移包的实际入口字节、同一新PID的3080/18998、health/recovery/Bridge、维护状态、OAuth已登录、模型/搜索保持以及认证浏览器实际插件激活；延迟再次读进程和健康。Task/Run/节点快照与历史读回分别检查，不能由服务端口或安装回执替代。

原v0文件始终保留，官方发布的后继格式也要独立核验。V4继续接受新业务事实后不能直接恢复旧宿主/旧数据快照；应先维护排空、保留新增事实、对账后前向修复。没有历史副本备份要求，本轮原始旧日志及冻结输入不会删除。

## 原生策略、并行设置与新版认证续接

正式pnpm策略必须逐字与冷候选一致。缺失native required peers时使用[薄offline续接](../acceptance/dsh-unified-upgrade/continuation.md)，不能切换autoInstallPeers。32个core依赖闭包来自真实父manifest声明，新CLI在app-boot缺包时无法进入命令处理，因此离线修复的唯一安装路径是原生pnpm install。

启动后有用户或并行会话设置变化时，不篡改旧launch/proof，不覆盖当前设置。读取现文件及完整preset，确认范围，使用`adopt-current-profile.ps1 -Check`再执行，只写全新私有证据目录。旧PS Verify存在ISO DateTime比较差异；唯一复验入口是`node docs/acceptance/dsh-unified-upgrade/scripts/verify-profile-adoption.mjs --arguments <采用参数JSON>`，保留原冻结源码，直接解析JSON字符串、CIM UTC identity、117旧输入及全部新证据，重新解析完整preset并调用实际包/worker verify。不能把无法恢复的旧prefix写成“全量不变”。完整快照放单独忽略的当前证据目录，其他生产内容不提交或放仓库外。

alpha2认证303 Location为`./`时，必须按原生URL解析为同origin根目标，仍要求cookie及认证200 HTML；外origin、非root或附query/hash拒绝。旧固定字面`/`的冻结探针不可改。`readback-native-host.ps1 -Check`复用18个原部署函数，仅将精确Web调用指向`verify-native-web.mjs`；其他包、任务、控制账、维护和新进程检查保持。冻结执行闭包及参数摘要后，Check实际ready；同入口`-Resume`再次CAS验证采用配置/同实例/闭包，沿原Resume一次恢复。恢复后独立回读双端口、健康、Bridge、recovery及维护状态；采用验证器限定恢复前封存，不在已inactive状态假报PASS。
