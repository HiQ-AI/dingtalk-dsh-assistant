param(
 [switch]$Check,
 [Parameter(Mandatory)][string]$HostUpgradeProposal,
 [Parameter(Mandatory)][string]$OriginEvidenceDirectory,
 [Parameter(Mandatory)][string]$EvidenceDirectory,
 [ValidateRange(1,600)][int]$WaitSeconds=300
)
$ErrorActionPreference='Stop'
$OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::InputEncoding=$OutputEncoding;[Console]::OutputEncoding=$OutputEncoding
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..')).Replace('\','/').TrimEnd('/')
$profile='D:/dsh_home/profiles/web';$runtime='D:/dsh_home/workflows/runtime-v2'
$node='D:/soft/node-v24.19.0/node.exe';$starter='D:/dsh_home/launchers/start-web.ps1'
$env:PATH=(Split-Path -Parent $node)+';'+$env:PATH
$pnpm=(Get-Command pnpm -ErrorAction Stop).Source
if((& $pnpm --version)-ne '10.13.1' -or $LASTEXITCODE){throw '续接要求既有pnpm 10.13.1'}
if((& $node --version)-notmatch '^v24\.' -or $LASTEXITCODE -or -not [IO.Path]::GetFullPath((Get-Command node -ErrorAction Stop).Source).Equals([IO.Path]::GetFullPath($node),[StringComparison]::OrdinalIgnoreCase)){throw '续接要求固定Node 24 PATH'}
$enrollmentTaskName='DSH Web Local';$Bootstrap=$false
$deploymentScript="$workspace/docs/acceptance/topic-context-completeness/scripts/deploy-owner-repair.ps1"
$checker="$workspace/docs/acceptance/topic-context-completeness/scripts/check-repair-deployment.mjs"
$hostUpgradeTool="$PSScriptRoot/apply-host-upgrade.mjs"
foreach($directory in @($OriginEvidenceDirectory,$EvidenceDirectory)){
 if(-not [IO.Path]::IsPathFullyQualified($directory) -or -not [IO.Path]::GetFullPath($directory).Replace('\','/').StartsWith("$workspace/docs/tmp/",[StringComparison]::OrdinalIgnoreCase)){throw '续接证据必须在当前工作区docs/tmp的绝对目录'}
}
if(Test-Path -LiteralPath $EvidenceDirectory){throw '续接证据目录必须全新'}
if(-not [IO.Path]::IsPathFullyQualified($HostUpgradeProposal)){throw '续接提案必须绝对路径'}
$originLaunchPath=Join-Path $OriginEvidenceDirectory 'launch.json'
$origin=Get-Content -LiteralPath $originLaunchPath -Raw|ConvertFrom-Json -AsHashtable
foreach($path in $origin.inputPaths){if((Get-FileHash -LiteralPath $path).Hash-ne $origin.inputHashes[$path]){throw '加载函数前原冻结输入已漂移'}}
foreach($required in @($deploymentScript,$hostUpgradeTool)){
 $matches=@($origin.inputPaths|Where-Object {[IO.Path]::GetFullPath($_).Replace('\','/').Equals([IO.Path]::GetFullPath($required).Replace('\','/'),[StringComparison]::OrdinalIgnoreCase)})
 if($matches.Count-ne 1){throw '原部署未唯一冻结原脚本及helper'}
}
# 只加载冻结原脚本的函数定义，绝不执行其顶层部署入口。
$tokens=$null;$parseErrors=$null
$originalAst=[Management.Automation.Language.Parser]::ParseFile($deploymentScript,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw '冻结原脚本无法解析'}
foreach($name in @('Run-Node','Listeners','Acquire-OwnerLock','Assert-ScheduledWebStart','Restore-EnrollmentAutostart','Start-DeployedWeb')){
 $definitions=@($originalAst.FindAll({param($ast) $ast -is [Management.Automation.Language.FunctionDefinitionAst] -and $ast.Name-eq $name},$false))
 if($definitions.Count-ne 1){throw '冻结原脚本函数身份不唯一'}
 . ([scriptblock]::Create($definitions[0].Extent.Text))
}
function Assert-ContinuationState($Origin,$Seal,$Maintenance,$TaskInfo,[string]$TaskState,[bool]$ProcessesAbsent,[bool]$PortsAbsent){
 if($Origin.launchMethod-ne 'scheduled-task' -or $Origin.launchTaskName-ne 'DSH Web Local' -or $Origin.mode-ne 'maintenance' -or $Origin.backupCreated-ne $false -or $Origin.repairOfLaunch -or -not $Origin.hostUpgradeProposal){throw '仅支持原首次宿主升级失败launch'}
 if(-not $ProcessesAbsent -or -not $PortsAbsent){throw '续接要求原进程及双端口均已退出'}
 if($TaskState-eq 'Running' -or [long]$TaskInfo.LastTaskResult-ne 1 -or ([datetime]$TaskInfo.LastRunTime).ToUniversalTime().ToString('yyyyMMddHHmmss')-ne ([datetime]$Origin.startedAt).ToUniversalTime().ToString('yyyyMMddHHmmss')){throw '原计划任务失败启动身份不匹配'}
 foreach($state in @($Seal,$Maintenance)){
  if($state.active-ne $true -or $state.phase-ne 'stopping' -or $state.drained-ne $true -or $state.maintenanceId-ne $Origin.maintenanceId -or -not $state.sealedIncarnation){throw '原维护持久封存状态不匹配'}
  foreach($kind in @('nodes','owners','effects','messages')){if($state.busy.$kind-ne 0){throw '原维护未排空'}}
 }
 if($Seal.stopPermitted-ne $true -or $Seal.processIncarnation-ne $Seal.sealedIncarnation){throw '原在线封存停机许可不匹配'}
 # checker maintenanceStatus(db)不传活进程incarnation：准确离线形状必须null/false。
 if($null-ne $Maintenance.processIncarnation -or $Maintenance.stopPermitted-ne $false -or $Maintenance.resumePermitted-ne $false){throw '当前维护读回不是原生离线状态'}
 foreach($key in @('revision','maintenanceId','sealedIncarnation')){if($Seal.$key-ne $Maintenance.$key){throw '原维护封存许可已漂移'}}
}
function Assert-ContinuationDependencies($Previous,$Next,$Closure){
 $added=@($Next.Keys|Where-Object {-not $Previous.Contains($_)})
 $addedNames=($added|Sort-Object)-join ',';$expectedNames=($Closure.extraDirect.Keys|Sort-Object)-join ','
 if($addedNames-cne $expectedNames){throw '续接新增依赖与完整原生闭包不一致'}
 $paths=@()
 foreach($name in $added){
  if($Next[$name]-cne $Closure.extraDirect[$name]){throw '续接core版本与闭包不一致'}
  $reasons=@($Closure.reasons|Where-Object {$_.peer-eq $name -and $_.selected-ceq $Next[$name]})
  if(-not $reasons.Count){throw '新增core没有原生声明证据'}
  foreach($reason in $reasons){
   if(-not [IO.Path]::IsPathFullyQualified($reason.declarerManifest) -or (Get-FileHash -LiteralPath $reason.declarerManifest).Hash.ToLowerInvariant()-ne $reason.declarerManifestSha256){throw '原生父声明manifest摘要不匹配'}
   $meta=Get-Content -LiteralPath $reason.declarerManifest -Raw|ConvertFrom-Json -AsHashtable
   if($meta.name-cne $reason.declarer -or $meta.name-cne $reason.actualName -or $meta.version-cne $reason.actualVersion -or $reason.optional-ne $false){throw '原生父声明身份不匹配'}
   if($reason.kind-eq 'requiredpeer'){
    if($meta.peerDependencies[$name]-cne $reason.range -or ($meta.peerDependenciesMeta -and $meta.peerDependenciesMeta[$name].optional-eq $true)){throw '原生requiredpeer声明不匹配'}
   }elseif($reason.kind-eq 'dependency'){
    if($meta.dependencies[$name]-cne $reason.range){throw '原生dependency声明不匹配'}
   }else{throw '原生core声明类型不匹配'}
   $paths+=$reason.declarerManifest
  }
 }
 return @($paths|Sort-Object -Unique)
}
function Test-ContinuationProcessesAbsent($Processes,[int]$OldPid,$LauncherPid,[string]$Profile,[string]$Starter,[int]$CurrentPid){
 $roots=@($Processes|Where-Object {$_.ProcessId-ne $CurrentPid -and ($_.ProcessId-eq $OldPid -or $_.ParentProcessId-eq $OldPid -or ($LauncherPid -and ($_.ProcessId-eq $LauncherPid -or $_.ParentProcessId-eq $LauncherPid)) -or ($_.CommandLine -and ($_.CommandLine.Replace('\','/').Contains("$Profile/node_modules/",[StringComparison]::OrdinalIgnoreCase) -or $_.CommandLine.Replace('\','/').Contains($Starter.Replace('\','/'),[StringComparison]::OrdinalIgnoreCase))))})
 return $roots.Count-eq 0
}
$originLaunchPath=Join-Path $OriginEvidenceDirectory 'launch.json'
$origin=Get-Content -LiteralPath $originLaunchPath -Raw|ConvertFrom-Json -AsHashtable
$sealed=Get-Content -LiteralPath (Join-Path $OriginEvidenceDirectory 'maintenance-sealed.json') -Raw|ConvertFrom-Json
$control=Get-Content -LiteralPath $origin.deploymentControlPath -Raw|ConvertFrom-Json -AsHashtable
$Package=(@($origin.inputPaths|Where-Object {(Get-FileHash -LiteralPath $_).Hash-eq $origin.packageSha256})|Select-Object -First 1)
if(-not $Package){throw '原Assistant包无法按SHA定位'}
$source="$workspace/packages/dingtalk-dsh-assistant";$installed="$profile/node_modules/@zzusp/dingtalk-dsh-assistant"
$observerSource="$workspace/packages/dingtalk-dsh-observer";$observerInstalled="$profile/node_modules/@zzusp/dingtalk-dsh-observer"
$ObserverPackage=$origin.observerPackage;$ExpectedObserverPackageSha256=$origin.observerPackageSha256
$ExpectedProfileSha256=$origin.sourceProfileSha256;$ExpectedPackageSha256=$origin.packageSha256
$proposal=Get-Content -LiteralPath $HostUpgradeProposal -Raw|ConvertFrom-Json -AsHashtable
$oldProposal=Get-Content -LiteralPath $origin.hostUpgradeProposal -Raw|ConvertFrom-Json -AsHashtable
if($proposal.patchAppend-ne '' -or $proposal.expectedPatchSha256.ToLowerInvariant()-ne $origin.profileSha256.ToLowerInvariant()){throw '续接不得修改已安装patch'}
foreach($section in @('dependencies','devDependencies','optionalDependencies')){
 $previous=if($oldProposal.packageJson[$section]){$oldProposal.packageJson[$section]}else{@{}}
 $next=if($proposal.packageJson[$section]){$proposal.packageJson[$section]}else{@{}}
 if($section-ne 'dependencies' -and $next.Count-ne $previous.Count){throw '续接只允许在dependencies追加原生core'}
 foreach($name in $previous.Keys){if($next[$name]-cne $previous[$name]){throw '续接只能新增原生core依赖，不得改原依赖'}}
 foreach($name in $next.Keys){if(-not $previous.Contains($name) -and (($name-like '@deepseek-ai/dsh*' -and $next[$name]-ne '0.2.1-alpha.2') -or ($name-notlike '@deepseek-ai/dsh*' -and $name-notin @('@deepseek-ai/cordis-plugin-group','@deepseek-ai/cordis-plugin-include','@deepseek-ai/cordis-plugin-timer')))){throw '续接新增依赖超出原生core精确范围'}}
}
if(($proposal.packageJson.pnpm.overrides|ConvertTo-Json -Compress)-cne ($oldProposal.packageJson.pnpm.overrides|ConvertTo-Json -Compress)){throw '续接五个本地包override不得改变'}
$closurePath="$workspace/docs/tmp/core-peer-closure.json"
$closure=Get-Content -LiteralPath $closurePath -Raw|ConvertFrom-Json -AsHashtable
$declarerPaths=Assert-ContinuationDependencies $oldProposal.packageJson.dependencies $proposal.packageJson.dependencies $closure
$candidateSummaryPath="$workspace/docs/tmp/candidate-repair-summary.json"
$candidateSummary=Get-Content -LiteralPath $candidateSummaryPath -Raw|ConvertFrom-Json
if($candidateSummary.kind-ne 'native-profile-peer-repair-candidate' -or $candidateSummary.policy.nodeLinker-ne 'hoisted' -or $candidateSummary.policy.autoInstallPeers-ne $false -or $candidateSummary.coldInstall-ne $true -or $candidateSummary.nativeCliAdd-ne $true -or $candidateSummary.authenticatedHeadlessUI-ne $true -or $candidateSummary.apiPrepared-ne 11 -or $candidateSummary.apiModels-ne 11 -or $candidateSummary.consolePageErrors-ne 0){throw '缺少相同原生安装策略与功能路径的冷候选证明'}
$policyProof=@($candidateSummary.files|Where-Object {$_.path-eq 'docs/tmp/candidate-repair/profiles/web/pnpm-workspace.yaml'})
if($policyProof.Count-ne 1 -or (Get-FileHash -LiteralPath "$workspace/$($policyProof[0].path)").Hash.ToLowerInvariant()-ne $policyProof[0].sha256 -or (Get-FileHash -LiteralPath "$profile/pnpm-workspace.yaml").Hash.ToLowerInvariant()-ne $policyProof[0].sha256){throw '正式原生安装策略与冷候选字节不一致'}
$candidateProofPaths=@()
foreach($proof in $candidateSummary.files){
 $file=[IO.Path]::GetFullPath((Join-Path $workspace $proof.path))
 if(-not $file.Replace('\','/').StartsWith("$workspace/docs/tmp/",[StringComparison]::OrdinalIgnoreCase) -or (Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()-ne $proof.sha256){throw '冷候选证明文件漂移'}
 $candidateProofPaths+=$file
}
$oldHostProofPath=Join-Path $OriginEvidenceDirectory 'host-upgrade-applied.json'
$oldHostProof=Get-Content -LiteralPath $oldHostProofPath -Raw|ConvertFrom-Json
if((Get-FileHash -LiteralPath $oldHostProofPath).Hash-ne $origin.hostUpgradeProofSha256 -or $oldHostProof.patchSha256.ToLowerInvariant()-ne $origin.profileSha256.ToLowerInvariant() -or $oldHostProof.packageJsonSha256-ne $proposal.expectedPackageJsonSha256){throw '原宿主升级proof链已漂移'}
$oldFiles=@{};$originalEvidenceHashes=@{}
foreach($name in @('launch.json','deployment-control.json','control-before.json','tasks-before.json','maintenance-sealed.json','enrollment-autostart.json','host-upgrade-applied.json','installed.json','observer-installed.json')){
 $file=Join-Path $OriginEvidenceDirectory $name
 if(Test-Path -LiteralPath $file){$originalEvidenceHashes[$file]=(Get-FileHash -LiteralPath $file).Hash;$oldFiles[$name]=$file}
}
if($control.backupCreated-ne $false -or $control.backup -or (Get-FileHash -LiteralPath $origin.deploymentControlPath).Hash-ne $origin.deploymentControlSha256 -or $control.sourceProfileSha256-ne $origin.sourceProfileSha256 -or $control.packageSha256-ne $origin.packageSha256 -or $control.oldPid-ne [int]($sealed.state.sealedIncarnation.Split(':')[0])){throw '原部署控制链不一致'}
$inputHashes=@{};foreach($path in $origin.inputPaths){$inputHashes[$path]=$origin.inputHashes[$path]}
$precheck=Run-Node @($hostUpgradeTool,'--check','--profile',$profile,'--proposal',$HostUpgradeProposal)|ConvertFrom-Json
$candidatePackageProof=@($candidateSummary.files|Where-Object {$_.path-eq 'docs/tmp/candidate-repair/profiles/web/package.json'})
if($candidatePackageProof.Count-ne 1 -or $candidatePackageProof[0].sha256-cne $precheck.packageJsonSha256){throw '冷候选manifest与本次提案不一致'}
foreach($path in @($PSCommandPath,$HostUpgradeProposal,$checker,$closurePath,$candidateSummaryPath,"$profile/pnpm-workspace.yaml",$pnpm)+@($candidateProofPaths)+@($declarerPaths)+@($precheck.localPackages|ForEach-Object path)){
 $hash=(Get-FileHash -LiteralPath $path).Hash
 if($inputHashes.ContainsKey($path) -and $inputHashes[$path]-ne $hash){throw '原冻结输入已变化'}
 $inputHashes[$path]=$hash
}
function Assert-ContinuationLock($Process) {if(-not $Process -or $Process.HasExited){throw '续接要求持续持有owner独占锁'}}
function Assert-FrozenContinuationInputs {
 foreach($path in $inputHashes.Keys){if((Get-FileHash -LiteralPath $path).Hash-ne $inputHashes[$path]){throw '续接冻结输入漂移'}}
 foreach($path in $originalEvidenceHashes.Keys){if((Get-FileHash -LiteralPath $path).Hash-ne $originalEvidenceHashes[$path]){throw '原证据漂移'}}
}
function Assert-ExactControlSnapshot {
 $baseline=Get-Content -LiteralPath "$OriginEvidenceDirectory/control-before.json" -Raw|ConvertFrom-Json -AsHashtable
 $actual=Run-Node @($checker,'snapshot')|ConvertFrom-Json -AsHashtable
 foreach($key in @('tasks','nodes','runs','legacy')){if(($baseline[$key]|ConvertTo-Json -Depth 100 -Compress)-cne ($actual[$key]|ConvertTo-Json -Depth 100 -Compress)){throw '续接控制快照不完全一致'}}
}
function Assert-OfflineContinuation {
 Assert-FrozenContinuationInputs
 $task=Assert-ScheduledWebStart $true
 $info=Get-ScheduledTaskInfo -TaskName $enrollmentTaskName -ErrorAction Stop
 $processes=@(Get-CimInstance Win32_Process)
 $absent=Test-ContinuationProcessesAbsent $processes ([int]$control.oldPid) $origin.launcherPid $profile $starter $PID
 $maintenance=Run-Node @($checker,'maintenance')|ConvertFrom-Json
 Assert-ContinuationState $origin $sealed.state $maintenance $info ([string]$task.State) $absent (@(Listeners).Count-eq 0)
 $null=Run-Node @($checker,'verify',"$OriginEvidenceDirectory/control-before.json")
 Assert-ExactControlSnapshot
 $null=Run-Node @($checker,'package',$Package,$source,$installed)
 if($ObserverPackage){$null=Run-Node @($checker,'package',$ObserverPackage,$observerSource,$observerInstalled)}
 return $maintenance
}
$maintenance=Assert-OfflineContinuation
if($Check){@{mode='check';writes=0;maintenanceId=$maintenance.maintenanceId;proposal=$precheck;frozenInputs=$inputHashes.Count}|ConvertTo-Json -Depth 10;exit 0}
New-Item -ItemType Directory -Path $EvidenceDirectory|Out-Null
$lockProcess=$null
try {
 $lockProcess=Acquire-OwnerLock
 $null=Assert-OfflineContinuation
 foreach($name in @('control-before.json','tasks-before.json','maintenance-sealed.json','enrollment-autostart.json')){
  if($oldFiles.ContainsKey($name)){Copy-Item -LiteralPath $oldFiles[$name] -Destination (Join-Path $EvidenceDirectory $name)}
 }
 Assert-ContinuationLock $lockProcess
 $applied=Run-Node @($hostUpgradeTool,'--apply','--profile',$profile,'--proposal',$HostUpgradeProposal)|ConvertFrom-Json
 if($applied.patchSha256-ne $precheck.patchSha256 -or $applied.packageJsonSha256-ne $precheck.packageJsonSha256){throw '续接apply与零写预检不一致'}
 Assert-ContinuationLock $lockProcess
 if(@(Listeners).Count){throw '续接安装前独占锁丢失'}
 Assert-FrozenContinuationInputs
 $env:DSH_HOME='D:/dsh_home';$env:TEMP="$runtime/local-acceptance/temp";$env:TMP=$env:TEMP
 # 新bin eager import app-boot，缺group时无法进入CLI；原生pnpm安装是唯一续接路径。
 & $pnpm --dir $profile install *> "$EvidenceDirectory/install.log"
 if($LASTEXITCODE){throw '续接原生安装失败，保持停机封存'}
 Assert-ContinuationLock $lockProcess
 $verified=Run-Node @($hostUpgradeTool,'--verify','--profile',$profile,'--proposal',$HostUpgradeProposal)|ConvertFrom-Json
 if($verified.patchSha256-ne $precheck.patchSha256){throw '续接安装改变patch'}
 $applied.packageJsonSha256=$verified.packageJsonSha256;$applied.migrationPackages=$verified.migrationPackages
 $applied|ConvertTo-Json -Depth 10|Set-Content "$EvidenceDirectory/host-upgrade-applied.json" -Encoding utf8
 Run-Node @($checker,'package',$Package,$source,$installed)|Set-Content "$EvidenceDirectory/installed.json"
 if($ObserverPackage){Run-Node @($checker,'package',$ObserverPackage,$observerSource,$observerInstalled)|Set-Content "$EvidenceDirectory/observer-installed.json"}
 $null=Run-Node @($checker,'verify',"$EvidenceDirectory/control-before.json")
 Assert-ExactControlSnapshot
 Assert-FrozenContinuationInputs
 Assert-ContinuationLock $lockProcess
 $newControl=@{backupCreated=$false;backup='';backupScope='none';oldPid=$control.oldPid;sourceProfileSha256=$origin.sourceProfileSha256;packageSha256=$origin.packageSha256;inputHashes=$inputHashes;repairOfControl=$origin.deploymentControlPath;repairOfControlSha256=$origin.deploymentControlSha256;originalEvidenceHashes=$originalEvidenceHashes}
 $newControl|ConvertTo-Json -Depth 10|Set-Content "$EvidenceDirectory/deployment-control.json" -Encoding utf8
} finally {
 if($lockProcess){$lockProcess.StandardInput.Close();if(-not $lockProcess.WaitForExit(10000)){throw '续接独占锁未释放，禁止启动'};if($lockProcess.ExitCode-ne 0){throw '续接独占锁异常退出，禁止启动'};$lockProcess.Dispose()}
}
Assert-FrozenContinuationInputs
$null=Assert-OfflineContinuation
$launch=Start-DeployedWeb @{enrollmentAutostartRestore=[bool]$origin.enrollmentAutostartRestore}
$record=$origin.Clone()
$record.repairOfLaunch=$originLaunchPath;$record.repairOfLaunchSha256=$originalEvidenceHashes[$originLaunchPath]
$record.hostUpgradeProposal=$HostUpgradeProposal;$record.hostUpgradeProofSha256=(Get-FileHash "$EvidenceDirectory/host-upgrade-applied.json").Hash
$record.deploymentControlPath="$EvidenceDirectory/deployment-control.json";$record.deploymentControlSha256=(Get-FileHash $record.deploymentControlPath).Hash
$record.inputPaths=@($inputHashes.Keys);$record.inputHashes=$inputHashes
$record.launcherPid=$launch.Id;$record.launchMethod=$launch.Method;$record.launchTaskName=$launch.TaskName;$record.startedAt=$launch.StartTime.ToUniversalTime().ToString('o')
$record|ConvertTo-Json -Depth 20|Set-Content "$EvidenceDirectory/launch.json" -Encoding utf8
@{status='started-in-sealed-maintenance';evidenceDirectory=$EvidenceDirectory;sourceProfileSha256=$record.sourceProfileSha256;profileSha256=$record.profileSha256;nextAction='沿冻结原部署脚本使用新HostUpgradeProposal及原Package/Observer/SHA参数 -Readback，再经核验 -Resume'}|ConvertTo-Json
