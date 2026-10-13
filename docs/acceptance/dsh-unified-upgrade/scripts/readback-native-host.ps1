param(
 [switch]$Check,
 [switch]$Resume,
 [Parameter(Mandatory)][string]$ArgumentsFile,
 [Parameter(Mandatory)][string]$AdoptionArgumentsFile,
 [Parameter(Mandatory)][string]$FrozenInputs,
 [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedInputsSha256
)
$ErrorActionPreference='Stop'
if($Check -and $Resume){throw 'Check不能恢复维护'}
$OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::InputEncoding=$OutputEncoding;[Console]::OutputEncoding=$OutputEncoding
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..')).Replace('\','/').TrimEnd('/')
$profile='D:/dsh_home/profiles/web';$runtime='D:/dsh_home/workflows/runtime-v2';$node='D:/soft/node-v24.19.0/node.exe'
$checker="$workspace/docs/acceptance/topic-context-completeness/scripts/check-repair-deployment.mjs"
$originalScript="$workspace/docs/acceptance/topic-context-completeness/scripts/deploy-owner-repair.ps1"
$scriptDirectory=[IO.Path]::GetFullPath($PSScriptRoot).Replace('\','/')
$nativeWeb="$scriptDirectory/verify-native-web.mjs";$adoptionVerifier="$scriptDirectory/verify-profile-adoption.mjs"
$hostUpgradeTool="$scriptDirectory/apply-host-upgrade.mjs"
$source="$workspace/packages/dingtalk-dsh-assistant";$installed="$profile/node_modules/@zzusp/dingtalk-dsh-assistant"
$observerSource="$workspace/packages/dingtalk-dsh-observer";$observerInstalled="$profile/node_modules/@zzusp/dingtalk-dsh-observer"
$starter='D:/dsh_home/launchers/start-web.ps1';$enrollmentTaskName='DSH Web Local';$WaitSeconds=60
$inputs=Get-Content -LiteralPath $FrozenInputs -Raw|ConvertFrom-Json -AsHashtable
$options=Get-Content -LiteralPath $ArgumentsFile -Raw|ConvertFrom-Json -AsHashtable
if((@($options.Keys|Sort-Object)-join ',')-ne 'EvidenceDirectory,ExpectedObserverPackageSha256,ExpectedPackageSha256,ExpectedProfileSha256,HostUpgradeProposal,ObserverPackage,Package'){throw '只支持当前独立宿主升级回读参数'}
foreach($key in $options.Keys){Set-Variable -Name $key -Value $options[$key]}
if(-not $EvidenceDirectory.Replace('\','/').StartsWith("$workspace/docs/tmp/",[StringComparison]::OrdinalIgnoreCase)){throw '证据目录必须在当前工作区docs/tmp'}
$launchRecord=Get-Content -LiteralPath "$EvidenceDirectory/launch.json" -Raw|ConvertFrom-Json
function Assert-NativeInputs {
 if((Get-FileHash -LiteralPath $FrozenInputs).Hash.ToLowerInvariant()-ne $ExpectedInputsSha256.ToLowerInvariant()){throw '原生回读清单CAS漂移'}
 if($inputs.kind-ne 'native-alpha2-readback'){throw '原生回读冻结清单类型错误'}
 foreach($path in @($PSCommandPath,$originalScript,$checker,$nativeWeb,$adoptionVerifier,$hostUpgradeTool,$ArgumentsFile,$AdoptionArgumentsFile,"$EvidenceDirectory/launch.json")){
  if(-not $inputs.hashes.ContainsKey($path) -or (Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant()-ne $inputs.hashes[$path]){throw '原生回读必需输入未冻结或漂移'}
 }
 foreach($path in $inputs.hashes.Keys){if((Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant()-ne $inputs.hashes[$path]){throw '原生回读执行闭包漂移'}}
 foreach($path in $launchRecord.inputPaths){if((Get-FileHash -LiteralPath $path).Hash-ne $launchRecord.inputHashes.$path){throw '原部署冻结输入漂移'}}
}
Assert-NativeInputs
# 固定加载原部署函数定义；不执行安装/停止/启动的顶层入口。
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($originalScript,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw '原部署函数AST错误'}
$names=@('Run-Node','Listeners','Instance','Restore-EnrollmentAutostart','Assert-ScheduledWebStart','Assert-DeploymentLaunchProcess','Get-DeploymentWebLog','Assert-ExecutionEventsIndexReadback','Assert-RequiredDependencyReadback','Assert-MessageImpactReadback','Change-MaintenancePhase','Assert-LaunchInputs','Test-MaintenanceBackfillPause','Read-DeploymentRuntime','Resume-Deployment','Assert-DeploymentControlRecord','Assert-ConfigurationRestoreReadback','Read-Deployment')
foreach($name in $names){
 $definitions=@($ast.FindAll({param($n)$n-is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name-eq $name},$false))
 if($definitions.Count-ne 1){throw '原部署函数必须唯一'}
 . ([scriptblock]::Create($definitions[0].Extent.Text))
}
$originalNode=(Get-Item Function:Run-Node).ScriptBlock
function Run-Node([string[]]$Arguments){
 # 唯一替换的是新版原生Web认证探针；没有失败后放行或伪造HTTP响应。
 if($Arguments.Count-eq 3 -and $Arguments[0]-eq $checker -and $Arguments[1]-eq 'web'){
  $result=& $node $nativeWeb --log $Arguments[2]
  if($LASTEXITCODE){throw '新版原生Web认证验收失败'}
  return ($result -join "`n")
 }
 & $originalNode -Arguments $Arguments
}
$deploymentInputs=@()
foreach($required in @($Package,$ObserverPackage,$HostUpgradeProposal,$hostUpgradeTool,$originalScript)){
 $matches=@($launchRecord.inputPaths|Where-Object {[IO.Path]::GetFullPath($_).Replace('\','/').Equals([IO.Path]::GetFullPath($required).Replace('\','/'),[StringComparison]::OrdinalIgnoreCase)})
 if($matches.Count-ne 1){throw '原部署必需输入必须唯一'}
 $deploymentInputs+=@($matches[0])
}
Assert-LaunchInputs $launchRecord
$adoptionProof=& $node $adoptionVerifier --arguments $AdoptionArgumentsFile
if($LASTEXITCODE){throw '采用配置验证失败'}
$result=Read-Deployment $launchRecord
if($Check -or -not $Resume){$result|ConvertTo-Json -Depth 10;exit}
if(-not $result.ready){throw '完整回读未ready，禁止恢复'}
Assert-NativeInputs
$adoptionProof=& $node $adoptionVerifier --arguments $AdoptionArgumentsFile
if($LASTEXITCODE){throw '恢复前配置CAS或同实例维护验证失败'}
$result=Resume-Deployment $result $launchRecord
$result|ConvertTo-Json -Depth 10
