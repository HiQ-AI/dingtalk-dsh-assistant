param(
 [ValidateSet('check','offline','reconcile','install','start','readback','resume-dispatch')][string]$Phase='check',
 [string]$ExecutionPlanFile,
 [Parameter(Mandatory)][string]$Package,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPackageSha256,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedProfileSha256,
 [ValidateRange(1,600)][int]$WaitSeconds=300
)
$ErrorActionPreference='Stop'
$workspace='D:/project/worktrees/dingtalk-topic-context-completeness';$profile='D:/dsh_home/profiles/web';$runtime='D:/dsh_home/workflows/runtime-v2'
$node='D:/soft/node-v24.19.0/node.exe';$source="$workspace/packages/dingtalk-dsh-assistant";$installed="$profile/node_modules/@zzusp/dingtalk-dsh-assistant"
$domain='D:/dsh_home/storages/dingtalk-dsh-assistant-v9-pr116';$checker=Join-Path $PSScriptRoot 'check-repair-deployment.mjs';$native=Join-Path $PSScriptRoot 'reconcile-pr371-native.mjs'
$bootstrapTool="$workspace/scripts/bootstrap-workflow-maintenance.mjs";$starter='D:/project/dingtalk-dsh-assistant/scripts/start-web.ps1'
$EvidenceDirectory="$workspace/docs/tmp/pr371-native-incident";$tempDirectory="$runtime/local-acceptance/temp"
$effectId='git-53f2dfc6458bb6f3e171908285fd98233bfc09e5c4fe1c320ecbd50cbe6a8b57';$manifestDigest='ad79714e913609b66b9b24298dff97bcf2704319ea6cfaf2fb9466c682d47242'
# 仅加载既有函数AST，不执行正常deploy主程序，也不修改它的unknown门禁。
$parseErrors=$null;$tokens=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'deploy-owner-repair.ps1'),[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw '部署复用函数解析失败'}
foreach($name in @('Run-Node','Listeners','Instance','Same-Hash','Acquire-OwnerLock','Wait-BootstrapResidentClosed','Wait-BootstrapWitness','Change-Maintenance','Read-Deployment','Resume-Deployment','Change-MaintenancePhase')){
 $fn=$ast.Find({param($item)$item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq $name},$true);if(-not $fn){throw '部署函数缺失'};Invoke-Expression $fn.Extent.Text
}
function Json-File([string]$name){Get-Content -LiteralPath "$EvidenceDirectory/$name" -Raw|ConvertFrom-Json}
function Save-New([string]$name,$value){$path="$EvidenceDirectory/$name";$bytes=[Text.Encoding]::UTF8.GetBytes(($value|ConvertTo-Json -Depth 30));$stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}}
function Assert-Authorized {
 $a=Json-File 'execution-plan.json'
 if($a.manifestDigest-ne $manifestDigest -or $a.scope-ne 'pr371-native-recovery'){throw '事故恢复尚未授权'}
}
function Assert-Package {if(-not [IO.Path]::IsPathFullyQualified($Package) -or (Get-FileHash -LiteralPath $Package).Hash-ne $ExpectedPackageSha256){throw '包身份不符'}}
function Assert-Capacity {
 $backupBytes=(@(Get-ChildItem -LiteralPath $domain,"$runtime/artifacts" -File -Recurse)+@(Get-ChildItem -LiteralPath $runtime,$profile -File)|Measure-Object Length -Sum).Sum
 $required=[long]$backupBytes+([long](Get-Item -LiteralPath $Package).Length*10)+1GB
 if((Get-PSDrive D).Free-lt $required){throw '事故维护备份/安装磁盘余量不足，未停机'}
}
Assert-Package
if($Phase-eq 'check'){
 Assert-Capacity
 $gate=Run-Node @($native,'--check')|ConvertFrom-Json
 if((Get-FileHash -LiteralPath "$profile/cordis.patch.yml").Hash-ne $ExpectedProfileSha256){throw '配置CAS漂移'}
 $proof=Run-Node @($checker,'package',$Package,$source)|ConvertFrom-Json
 @{writes=0;gate=$gate;package=$proof}|ConvertTo-Json -Depth 10;exit
}
if(-not(Test-Path -LiteralPath $EvidenceDirectory)){
 if($Phase-ne 'offline' -or -not $ExecutionPlanFile){throw '必须先审批离线阶段'}
 $gate=Run-Node @($native,'--check')|ConvertFrom-Json
 $a=Get-Content -LiteralPath $ExecutionPlanFile -Raw|ConvertFrom-Json
 if($a.manifestDigest-ne $manifestDigest -or $a.scope-ne 'pr371-native-recovery'){throw '事故恢复尚未授权'}
 New-Item -ItemType Directory -Path $EvidenceDirectory|Out-Null
 Save-New 'execution-plan.json' $a
 Save-New 'inputs.json' @{package=$Package;packageSha256=$ExpectedPackageSha256;profileSha256=$ExpectedProfileSha256;manifestDigest=$manifestDigest}
}
Assert-Authorized
$inputs=Json-File 'inputs.json'
if($inputs.package-ne $Package -or $inputs.packageSha256-ne $ExpectedPackageSha256 -or $inputs.profileSha256-ne $ExpectedProfileSha256){throw '接续输入漂移'}
if($Phase-in @('readback','resume-dispatch')){
 $launch=Json-File 'launch.json';$result=Read-Deployment $launch
 if($Phase-eq 'resume-dispatch'){$result=Resume-Deployment $result $launch}
 $result|ConvertTo-Json -Depth 20;exit
}
if(Test-Path -LiteralPath "$EvidenceDirectory/$Phase.done.json"){Json-File "$Phase.done.json"|ConvertTo-Json -Depth 20;exit}
if(Test-Path -LiteralPath "$EvidenceDirectory/$Phase.started.json"){
 if($Phase-eq 'reconcile'){$readback=Run-Node @($native,'--readback')|ConvertFrom-Json;if($readback.complete){Save-New 'reconcile.done.json' $readback;$readback|ConvertTo-Json -Depth 20;exit}}
 throw '阶段结果不确定，仅可readback/人工核对，禁止重复执行'
}
$prerequisite=@{reconcile='offline';install='reconcile';start='install'}[$Phase]
if($prerequisite -and -not(Test-Path -LiteralPath "$EvidenceDirectory/$prerequisite.done.json")){throw '前序阶段未完成'}
$lockProcess=$null
try {
 if($Phase-eq 'offline'){
  Assert-Capacity
  $null=Run-Node @($native,'--check');$old=Instance;if(-not $old){throw '缺少原实例'}
  if((Get-FileHash -LiteralPath "$profile/cordis.patch.yml").Hash-ne $ExpectedProfileSha256){throw '配置CAS漂移'}
  $null=Run-Node @($checker,'package',$Package,$source)
  $before=Invoke-RestMethod http://127.0.0.1:18998/runtime/maintenance -NoProxy -TimeoutSec 20
  if($before.active){throw '已有维护许可，禁止接管'}
  $maintenanceId='deploy-'+[guid]::NewGuid();$nonce=[guid]::NewGuid().ToString()
  Save-New 'offline.started.json' @{oldPid=$old.ProcessId;maintenanceId=$maintenanceId;nonce=$nonce}
  $entered=Change-Maintenance $before $true $maintenanceId
  $null=Run-Node @($native,'--check')
  Copy-Item -LiteralPath "$profile/cordis.patch.yml" -Destination "$EvidenceDirectory/profile-original.yml";Same-Hash "$profile/cordis.patch.yml" "$EvidenceDirectory/profile-original.yml"
  $witness=Run-Node @($bootstrapTool,'witness','--profile',"$profile/cordis.patch.yml",'--expected-sha256',$ExpectedProfileSha256,'--evidence-directory',$EvidenceDirectory,'--expected-pid',[string]$old.ProcessId,'--nonce',$nonce)|ConvertFrom-Json
  $null=Wait-BootstrapWitness 'ready' $old $nonce
  $disabled=Run-Node @($bootstrapTool,'disable','--profile',"$profile/cordis.patch.yml",'--expected-sha256',$witness.afterSha256)|ConvertFrom-Json
  $null=Wait-BootstrapWitness 'disposed' $old $nonce;Wait-BootstrapResidentClosed $old
  $lockProcess=Acquire-OwnerLock
  $null=Run-Node @($native,'--snapshot')
  if($lockProcess.HasExited){throw '独占锁丢失'}
  $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($old.ProcessId)";if($current.CreationDate-ne $old.CreationDate){throw 'PID身份漂移'}
  Stop-Process -Id $old.ProcessId -Force
  if(@(Listeners).Count){throw '原实例仍监听'}
  $backup="$EvidenceDirectory/backup";New-Item -ItemType Directory -Path $backup,"$backup/runtime","$backup/profile"|Out-Null
  Copy-Item -LiteralPath $domain -Destination "$backup/domain" -Recurse
  Get-ChildItem -LiteralPath $runtime -File|Copy-Item -Destination "$backup/runtime"
  Copy-Item -LiteralPath "$runtime/artifacts" -Destination "$backup/runtime/artifacts" -Recurse
  foreach($name in @('cordis.patch.yml','cordis.yml','package.json','package-lock.json','settings.yaml','pnpm-lock.yaml')){if(Test-Path "$profile/$name"){Copy-Item "$profile/$name" "$backup/profile/$name"}}
  $proof=Run-Node @($checker,'backup-verify',$backup)|ConvertFrom-Json
  $record=@{effectId=$effectId;manifestDigest=$manifestDigest;maintenanceId=$maintenanceId;backup=$backup;disabledProfileSha256=$disabled.afterSha256;backupProof=$proof}
  Save-New 'offline.json' $record;Save-New 'offline.done.json' $record
 }elseif($Phase-eq 'reconcile'){
  if(@(Listeners).Count){throw '离线对账发现监听'}
  Save-New 'reconcile.started.json' @{at=(Get-Date).ToUniversalTime().ToString('o')}
  $result=Run-Node @($native,'--reconcile')|ConvertFrom-Json
  Save-New 'reconcile.done.json' $result
 }elseif($Phase-eq 'install'){
  if(@(Listeners).Count){throw '安装前发现监听'}
  $offline=Json-File 'offline.json';if((Get-FileHash "$profile/cordis.patch.yml").Hash-ne $offline.disabledProfileSha256){throw '禁用配置漂移'}
  $ready=Run-Node @($native,'--readback')|ConvertFrom-Json;if(-not $ready.complete){throw '原生对账尚未完整完成'};$lockProcess=Acquire-OwnerLock
  Run-Node @($checker,'snapshot')|Set-Content -LiteralPath "$EvidenceDirectory/control-before.json"
  Save-New 'install.started.json' @{at=(Get-Date).ToUniversalTime().ToString('o')}
  $env:DSH_HOME='D:/dsh_home';$env:TEMP=$tempDirectory;$env:TMP=$tempDirectory
  & $node "$profile/node_modules/@deepseek-ai/dsh/lib/bin.js" plugin --profile web add $Package *> "$EvidenceDirectory/install.log"
  if($LASTEXITCODE){throw '安装失败，保持停机'}
  $proof=Run-Node @($checker,'package',$Package,$source,$installed)|ConvertFrom-Json
  if((Get-FileHash "$profile/cordis.patch.yml").Hash-ne $offline.disabledProfileSha256){throw '安装修改了禁用配置，禁止启动'}
  Save-New 'install.done.json' $proof
 }elseif($Phase-eq 'start'){
  if(@(Listeners).Count){throw '启动前发现监听'}
  $ready=Run-Node @($native,'--readback')|ConvertFrom-Json;if(-not $ready.complete){throw '原生对账尚未完整完成'};$offline=Json-File 'offline.json'
  $null=Run-Node @($checker,'package',$Package,$source,$installed)
  if((Get-FileHash -LiteralPath "$profile/cordis.patch.yml").Hash-ne $offline.disabledProfileSha256){throw '启动前禁用配置漂移'}
  Save-New 'start.started.json' @{at=(Get-Date).ToUniversalTime().ToString('o')}
  $enabled=Run-Node @($bootstrapTool,'enable','--profile',"$profile/cordis.patch.yml",'--expected-sha256',$offline.disabledProfileSha256)|ConvertFrom-Json
  if($enabled.afterSha256-ne $ExpectedProfileSha256 -or (Get-FileHash -LiteralPath "$profile/cordis.patch.yml").Hash-ne $ExpectedProfileSha256){throw '恢复配置未匹配初始完整SHA，禁止启动'}
  $env:DSH_HOME='D:/dsh_home';$env:TEMP=$tempDirectory;$env:TMP=$tempDirectory;$env:PATH=(Split-Path $node -Parent)+';'+$env:PATH
  $launch=Start-Process pwsh -ArgumentList @('-NoProfile','-File',$starter) -WindowStyle Hidden -PassThru -RedirectStandardOutput "$EvidenceDirectory/start.stdout.log" -RedirectStandardError "$EvidenceDirectory/start.stderr.log"
  $record=@{launcherPid=$launch.Id;startedAt=$launch.StartTime.ToUniversalTime().ToString('o');packageSha256=$ExpectedPackageSha256;sourceProfileSha256=$ExpectedProfileSha256;profileSha256=$enabled.afterSha256;maintenanceId=$offline.maintenanceId}
  Save-New 'launch.json' $record;Save-New 'start.done.json' $record
 }
} finally {if($lockProcess){$lockProcess.StandardInput.Close();if(-not $lockProcess.WaitForExit(10000)){throw '独占锁未释放'};$lockProcess.Dispose()}}
Json-File "$Phase.done.json"|ConvertTo-Json -Depth 20
