param(
 [ValidateSet('check','offline','reconcile','install','start','readback','resume-dispatch')][string]$Phase='check',
 [Parameter(Mandatory)][string]$Manifest,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedManifestSha256,
 [ValidateRange(1,600)][int]$WaitSeconds=60
)
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).Replace('\','/')
if(-not [IO.Path]::IsPathFullyQualified($Manifest) -or (Get-FileHash -LiteralPath $Manifest).Hash.ToLower()-ne $ExpectedManifestSha256){throw '交接manifest身份不符'}
$m=Get-Content -LiteralPath $Manifest -Raw|ConvertFrom-Json
if($m.version-ne 1 -or $m.scope-ne 'data-change-approval-handoff'){throw '交接manifest合同不符'}
$profile=$m.profileDirectory;$runtime=$m.runtimeDirectory;$domain=$m.domainDirectory
$Package=$m.packagePath;$ExpectedPackageSha256=$m.packageSha256;$ExpectedProfileSha256=$m.expectedProfileSha256
$EvidenceDirectory=$m.evidenceDirectory;$TaskDirectory=$m.taskDirectory
if(-not [IO.Path]::IsPathFullyQualified($EvidenceDirectory) -or -not $EvidenceDirectory.Replace('\','/').StartsWith("$workspace/docs/tmp/",[StringComparison]::OrdinalIgnoreCase)){throw '证据目录须在本检出docs/tmp内'}
$node='D:/soft/node-v24.19.0/node.exe';$source="$workspace/packages/dingtalk-dsh-assistant";$installed="$profile/node_modules/@zzusp/dingtalk-dsh-assistant"
$checker="$workspace/docs/acceptance/topic-context-completeness/scripts/check-repair-deployment.mjs"
$native="$workspace/scripts/reconcile-data-change-approval.mjs";$bootstrapTool="$workspace/scripts/bootstrap-workflow-maintenance.mjs"
$starter='D:/project/dingtalk-dsh-assistant/scripts/start-web.ps1';$enrollmentTaskName='DSH Web Local'
$Bootstrap=$true;$MigrateMessageImpact=$false;$tempDirectory="$runtime/local-acceptance/temp"
$ObserverPackage='';$ExpectedObserverPackageSha256='';$DirectQueriesProposal='';$TaskMigrationPlan=''
$parseErrors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile("$workspace/docs/acceptance/topic-context-completeness/scripts/deploy-owner-repair.ps1",[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw '部署函数解析失败'}
foreach($name in @('Run-Node','Listeners','Instance','Same-Hash','Acquire-OwnerLock','Wait-DrainedSnapshot','Wait-BootstrapResidentClosed','Wait-BootstrapWitness','Change-Maintenance','Read-Deployment','Resume-Deployment','Change-MaintenancePhase','Restore-EnrollmentAutostart','Assert-MessageImpactReadback')){
 $fn=$ast.Find({param($item)$item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq $name},$true)
 if(-not $fn){throw "部署函数缺失：$name"};Invoke-Expression $fn.Extent.Text
}
function Save-New([string]$name,$value){
 $path=Join-Path $EvidenceDirectory $name
 $bytes=[Text.Encoding]::UTF8.GetBytes(($value|ConvertTo-Json -Depth 50))
 $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Json-File([string]$name){Get-Content -LiteralPath (Join-Path $EvidenceDirectory $name) -Raw|ConvertFrom-Json}
function Assert-Inputs {
 if(-not [IO.Path]::IsPathFullyQualified($Package) -or (Split-Path -Parent $Package).Replace('\','/')-ne 'D:/dsh_home/packages' -or (Get-FileHash -LiteralPath $Package).Hash.ToLower()-ne $ExpectedPackageSha256){throw '正式包身份不符'}
 if(-not [IO.Path]::IsPathFullyQualified($TaskDirectory)){throw 'Task备份目录须显式指定'}
}
function Assert-Capacity {
 $taskProof=Run-Node @($checker,'task-directory-check',$TaskDirectory)|ConvertFrom-Json
 $backupBytes=(@(Get-ChildItem -LiteralPath $domain,"$runtime/artifacts" -File -Recurse)+@(Get-ChildItem -LiteralPath $runtime,$profile -File)|Measure-Object Length -Sum).Sum
 $required=[long]$backupBytes+[long]$taskProof.taskBytes+([long](Get-Item -LiteralPath $Package).Length*10)+1GB
 if((Get-PSDrive D).Free-lt $required){throw '备份及安装空间不足，未停机'}
}
Assert-Inputs
if($Phase-eq 'check'){
 Assert-Capacity
 if((Get-FileHash -LiteralPath $m.profilePath).Hash.ToLower()-ne $ExpectedProfileSha256){throw '配置CAS漂移'}
 $gate=Run-Node @($native,'--check','--manifest',$Manifest)|ConvertFrom-Json
 $proof=Run-Node @($checker,'package',$Package,$source)|ConvertFrom-Json
 @{writes=0;gate=$gate;package=$proof}|ConvertTo-Json -Depth 15;exit
}
if(-not(Test-Path -LiteralPath $EvidenceDirectory)){
 if($Phase-ne 'offline'){throw '先完成offline阶段'}
 New-Item -ItemType Directory -Path $EvidenceDirectory|Out-Null
 Save-New 'inputs.json' @{manifest=$Manifest;manifestSha256=$ExpectedManifestSha256;package=$Package;packageSha256=$ExpectedPackageSha256;profileSha256=$ExpectedProfileSha256}
}
$inputs=Json-File 'inputs.json'
if($inputs.manifest-ne $Manifest -or $inputs.manifestSha256-ne $ExpectedManifestSha256 -or $inputs.package-ne $Package -or $inputs.packageSha256-ne $ExpectedPackageSha256){throw '接续输入漂移'}
if($Phase-in @('readback','resume-dispatch')){
 $launch=Json-File 'launch.json';$result=Read-Deployment $launch
 if($Phase-eq 'resume-dispatch'){$result=Resume-Deployment $result $launch}
 $result|ConvertTo-Json -Depth 20;exit
}
if(Test-Path -LiteralPath "$EvidenceDirectory/$Phase.done.json"){Json-File "$Phase.done.json"|ConvertTo-Json -Depth 20;exit}
if(Test-Path -LiteralPath "$EvidenceDirectory/$Phase.started.json"){
 if($Phase-eq 'reconcile'){
  $readback=Run-Node @($native,'--readback','--manifest',"$EvidenceDirectory/reconcile-manifest.json")|ConvertFrom-Json
  if($readback.complete){Save-New 'reconcile.done.json' $readback;$readback|ConvertTo-Json -Depth 20;exit}
 }else{throw '阶段执行已开始但结果未确认，只能独立回读，禁止重复操作'}
}
$prerequisite=@{reconcile='offline';install='reconcile';start='install'}[$Phase]
if($prerequisite -and -not(Test-Path -LiteralPath "$EvidenceDirectory/$prerequisite.done.json")){throw '前序阶段未完成'}
$lockProcess=$null
try {
 if($Phase-eq 'offline'){
  Assert-Capacity
  $null=Run-Node @($native,'--check','--manifest',$Manifest)
  $old=Instance;if(-not $old -or $old.ProcessId-ne $m.expectedPid){throw '原实例PID漂移'}
  if((Get-FileHash -LiteralPath $m.profilePath).Hash.ToLower()-ne $ExpectedProfileSha256){throw '配置CAS漂移'}
  $null=Run-Node @($checker,'package',$Package,$source)
  $before=Invoke-RestMethod http://127.0.0.1:18998/runtime/maintenance -NoProxy -TimeoutSec 20
  if($before.active){throw '已有维护许可，禁止接管'}
  $maintenanceId='deploy-'+[guid]::NewGuid();$nonce=[guid]::NewGuid().ToString()
  Save-New 'offline.started.json' @{oldPid=$old.ProcessId;createdAt=$old.CreationDate;maintenanceId=$maintenanceId;nonce=$nonce}
  $entered=Change-Maintenance $before $true $maintenanceId
  $null=Run-Node @($native,'--check','--manifest',$Manifest)
  $scheduled=Get-ScheduledTask -TaskName $enrollmentTaskName
  $restore=[string]$scheduled.State-ne 'Disabled'
  Save-New 'enrollment-autostart.json' @{taskName=$enrollmentTaskName;restore=$restore}
  if($restore){$null=Disable-ScheduledTask -TaskName $enrollmentTaskName}
  if([string](Get-ScheduledTask -TaskName $enrollmentTaskName).State-ne 'Disabled'){throw '自启任务未禁用'}
  Copy-Item -LiteralPath $m.profilePath -Destination "$EvidenceDirectory/profile-original.yml"
  Same-Hash $m.profilePath "$EvidenceDirectory/profile-original.yml"
  $witness=Run-Node @($bootstrapTool,'witness','--profile',$m.profilePath,'--expected-sha256',$ExpectedProfileSha256,'--evidence-directory',$EvidenceDirectory,'--expected-pid',[string]$old.ProcessId,'--nonce',$nonce)|ConvertFrom-Json
  $null=Wait-BootstrapWitness 'ready' $old $nonce
  $disabled=Run-Node @($bootstrapTool,'disable','--profile',$m.profilePath,'--expected-sha256',$witness.afterSha256)|ConvertFrom-Json
  $null=Wait-BootstrapWitness 'disposed' $old $nonce
  Wait-BootstrapResidentClosed $old
  $lockProcess=Acquire-OwnerLock
  $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($old.ProcessId)"
  if($current.CreationDate-ne $old.CreationDate){throw 'PID出生身份漂移'}
  Stop-Process -Id $old.ProcessId -Force
  if(@(Listeners).Count){throw '原实例仍监听'}
  $backup="D:/dsh_home/backups/approval-handoff-"+(Get-Date -Format yyyyMMdd-HHmmss-fff)
  New-Item -ItemType Directory -Path $backup,"$backup/runtime","$backup/profile"|Out-Null
  Copy-Item -LiteralPath $domain -Destination "$backup/domain" -Recurse
  Get-ChildItem -LiteralPath $runtime -File|Copy-Item -Destination "$backup/runtime"
  Copy-Item -LiteralPath "$runtime/artifacts" -Destination "$backup/runtime/artifacts" -Recurse
  $null=Run-Node @($checker,'task-directory-copy',$TaskDirectory,"$backup/tasks")
  foreach($name in @('cordis.patch.yml','cordis.yml','package.json','package-lock.json','settings.yaml','pnpm-lock.yaml')){
   if(Test-Path -LiteralPath "$profile/$name"){Copy-Item -LiteralPath "$profile/$name" -Destination "$backup/profile/$name";Same-Hash "$profile/$name" "$backup/profile/$name"}
  }
  Same-Hash "$runtime/control.sqlite" "$backup/runtime/control.sqlite"
  $proof=Run-Node @($checker,'backup-verify',$backup,$TaskDirectory)|ConvertFrom-Json
  $proof|ConvertTo-Json -Depth 50|Set-Content -LiteralPath "$backup/manifest.json" -Encoding utf8
  $record=@{maintenanceId=$maintenanceId;actorId=$entered.state.actorId;disabledProfileSha256=$disabled.afterSha256;backupRoot=$backup;taskDirectory=$TaskDirectory;backupProofSha256=(Get-FileHash "$backup/manifest.json").Hash.ToLower()}
  $reconcileManifest=Get-Content -LiteralPath $Manifest -Raw|ConvertFrom-Json -AsHashtable
  $reconcileManifest.offline=$record;Save-New 'reconcile-manifest.json' $reconcileManifest
  Save-New 'offline.done.json' $record
 }elseif($Phase-eq 'reconcile'){
  if(@(Listeners).Count){throw '对账发现监听'}
  if(-not(Test-Path -LiteralPath "$EvidenceDirectory/reconcile.started.json")){Save-New 'reconcile.started.json' @{at=(Get-Date).ToUniversalTime().ToString('o')}}
  $result=Run-Node @($native,'--reconcile','--manifest',"$EvidenceDirectory/reconcile-manifest.json")|ConvertFrom-Json
  Save-New 'reconcile.done.json' $result
 }elseif($Phase-eq 'install'){
  if(@(Listeners).Count){throw '安装前发现监听'}
  $offline=Json-File 'offline.done.json'
  if((Get-FileHash -LiteralPath $m.profilePath).Hash.ToLower()-ne $offline.disabledProfileSha256){throw '禁用配置漂移'}
  $ready=Run-Node @($native,'--readback','--manifest',"$EvidenceDirectory/reconcile-manifest.json")|ConvertFrom-Json
  if(-not $ready.complete){throw '对账尚未完成'}
  $lockProcess=Acquire-OwnerLock
  Run-Node @($checker,'snapshot')|Set-Content -LiteralPath "$EvidenceDirectory/control-before.json" -Encoding utf8
  Save-New 'install.started.json' @{at=(Get-Date).ToUniversalTime().ToString('o')}
  $env:DSH_HOME='D:/dsh_home';$env:TEMP=$tempDirectory;$env:TMP=$tempDirectory
  & $node "$profile/node_modules/@deepseek-ai/dsh/lib/bin.js" plugin --profile web add "@zzusp/dingtalk-dsh-assistant@file:$Package" *> "$EvidenceDirectory/install.log"
  if($LASTEXITCODE){throw '安装失败，保持停机'}
  $proof=Run-Node @($checker,'package',$Package,$source,$installed)|ConvertFrom-Json
  if((Get-FileHash -LiteralPath $m.profilePath).Hash.ToLower()-ne $offline.disabledProfileSha256){throw '安装修改禁用配置'}
  Save-New 'install.done.json' $proof
 }elseif($Phase-eq 'start'){
  if(@(Listeners).Count){throw '启动前发现监听'}
  $ready=Run-Node @($native,'--readback','--manifest',"$EvidenceDirectory/reconcile-manifest.json")|ConvertFrom-Json
  if(-not $ready.complete){throw '对账尚未完成'}
  $offline=Json-File 'offline.done.json'
  $null=Run-Node @($checker,'package',$Package,$source,$installed)
  if((Get-FileHash -LiteralPath $m.profilePath).Hash.ToLower()-ne $offline.disabledProfileSha256){throw '启动前配置漂移'}
  Save-New 'start.started.json' @{at=(Get-Date).ToUniversalTime().ToString('o')}
  $enabled=Run-Node @($bootstrapTool,'enable','--profile',$m.profilePath,'--expected-sha256',$offline.disabledProfileSha256)|ConvertFrom-Json
  if($enabled.afterSha256-ne $ExpectedProfileSha256){throw '完整配置恢复摘要不符'}
  $env:DSH_HOME='D:/dsh_home';$env:TEMP=$tempDirectory;$env:TMP=$tempDirectory;$env:PATH=(Split-Path $node -Parent)+';'+$env:PATH
  $launch=Start-Process pwsh -ArgumentList @('-NoProfile','-File',$starter) -WindowStyle Hidden -PassThru -RedirectStandardOutput "$EvidenceDirectory/start.stdout.log" -RedirectStandardError "$EvidenceDirectory/start.stderr.log"
  $record=@{mode='maintenance';launcherPid=$launch.Id;startedAt=$launch.StartTime.ToUniversalTime().ToString('o');packageSha256=$ExpectedPackageSha256;sourceProfileSha256=$ExpectedProfileSha256;profileSha256=$enabled.afterSha256;maintenanceId=$offline.maintenanceId;enrollmentAutostartRestore=(Json-File 'enrollment-autostart.json').restore}
  Save-New 'launch.json' $record;Save-New 'start.done.json' $record
 }
} finally {
 if($lockProcess){$lockProcess.StandardInput.Close();if(-not $lockProcess.WaitForExit(10000)){throw '独占锁尚未释放'};$lockProcess.Dispose()}
}
