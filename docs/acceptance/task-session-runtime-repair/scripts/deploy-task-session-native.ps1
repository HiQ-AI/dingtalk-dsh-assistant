param(
 [switch]$Check,
 [switch]$ResumeNativeDispose,
 [Parameter(Mandatory)][string]$Package,
 [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedPackageSha256,
 [Parameter(Mandatory)][int]$ExpectedPid,
 [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedProfileSha256,
 [Parameter(Mandatory)][string]$EvidenceDirectory,
 [Parameter(Mandatory)][string]$ObserverPackage,
 [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedObserverPackageSha256,
 [string]$PtyUpgradeProposal,
 [string]$ArtifactPolicyProposal,
 [string]$RestartMaintenanceProposal,
 [string]$DrainFailureMaintenanceProposal
)
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$profile='D:/dsh_home/profiles/web'
$patch="$profile/cordis.patch.yml"
$agentWorkspace='D:/baibu-agent'
$db="$agentWorkspace/.dsh/task-sessions.sqlite"
$node='D:/soft/node-v24.19.0/node.exe'
$starter='D:/dsh_home/launchers/start-web.ps1'
$entry="$profile/node_modules/@deepseek-ai/dsh/lib/bin.js"
# 代码包更新不能隐式切换宿主；本地运行时声明与安装版本漂移必须在停机前拒绝。
$hostDependency=(Get-Content "$profile/package.json" -Raw|ConvertFrom-Json).dependencies.'@deepseek-ai/dsh'
if($hostDependency -and $hostDependency.StartsWith('file:')){
 $declaredHost=[IO.Path]::GetFullPath($hostDependency.Substring(5),$profile)
 if(Test-Path -LiteralPath $declaredHost -PathType Container){
  $declaredVersion=(Get-Content (Join-Path $declaredHost 'package.json') -Raw|ConvertFrom-Json).version
  $installedVersion=(Get-Content "$profile/node_modules/@deepseek-ai/dsh/package.json" -Raw|ConvertFrom-Json).version
  if($declaredVersion-ne$installedVersion){throw 'DEPLOY_HOST_CONFIGURATION_DRIFT'}
 }
}
$installed="$profile/node_modules/@zzusp/dingtalk-dsh-assistant"
$checker=Join-Path $PSScriptRoot 'inspect-quiescent-ledger.mjs'
$ledger=Join-Path $PSScriptRoot 'inspect-quiescent-ledger.mjs'
$taskName='DSH Web Local'
$phase='check'
$ptyHelper=Join-Path $workspace 'scripts/pty-package-upgrade.mjs'
$artifactPolicyHelper=Join-Path $workspace 'scripts/sandbox-artifact-policy.mjs'
if($PtyUpgradeProposal -and $ArtifactPolicyProposal){throw 'DEPLOY_PATCH_MODES_CONFLICT'}
if($DrainFailureMaintenanceProposal-and($RestartMaintenanceProposal-or$PtyUpgradeProposal-or$ArtifactPolicyProposal-or$ResumeNativeDispose)){throw 'DEPLOY_MAINTENANCE_MODES_CONFLICT'}
if($ArtifactPolicyProposal){$ArtifactPolicyProposal=[IO.Path]::GetFullPath($ArtifactPolicyProposal)}
if($PtyUpgradeProposal){$PtyUpgradeProposal=[IO.Path]::GetFullPath($PtyUpgradeProposal)}
function Hash([string]$file){(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
function TextHash([string]$value){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($value))).ToLowerInvariant()}
function AssertDrainMaintenanceIdentity {
 if((Hash $DrainFailureMaintenanceProposal)-ne$drainMaintenanceHash){throw 'DEPLOY_MAINTENANCE_PROPOSAL_CHANGED'}
 $bound=$drainMaintenance.expectedHost
 if($bound.pid-ne$ExpectedPid-or([datetime]$bound.creationDate).ToUniversalTime()-ne$original.CreationDate.ToUniversalTime()-or$bound.commandLineSha256-cne(TextHash $original.CommandLine)){throw 'DEPLOY_MAINTENANCE_HOST_CHANGED'}
}
$packageCacheRoot='D:/dsh_home/packages/by-sha256'
function AssertPackagePath([string]$path){
 for($cursor=[IO.Path]::GetFullPath($path);$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)){
  if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'DEPLOY_PACKAGE_REPARSE'}}
 }
}
function ImmutablePackage([string]$path,[string]$expectedSha256){
 $digest=$expectedSha256.ToLowerInvariant()
 if($digest-notmatch'^[a-f0-9]{64}$'){throw 'DEPLOY_PACKAGE_DIGEST_INVALID'}
 $destination=Join-Path (Join-Path $packageCacheRoot $digest) 'package.tgz'
 AssertPackagePath $path;AssertPackagePath $destination
 if((Hash $path)-ne$digest){throw 'DEPLOY_PACKAGE_CHANGED'}
 [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))|Out-Null
 AssertPackagePath $destination
 if(-not(Test-Path -LiteralPath $destination)){[IO.File]::Copy($path,$destination,$false)}
 if((Hash $destination)-ne$digest){throw 'DEPLOY_IMMUTABLE_PACKAGE_MISMATCH'}
 return $destination
}
function RunNode([string[]]$Arguments){
 $output=& $node @Arguments 2>&1
 if($LASTEXITCODE){
  $code=@($output|ForEach-Object {[string]$_}|Where-Object {$_-cmatch'^DEPLOY_[A-Z0-9_]+$'}|Select-Object -First 1)
  if($code.Count){throw $code[0]}
  throw "DEPLOY_NODE_CHECK_FAILED:$($Arguments[0]):$($Arguments[1])"
 }
 $output=@($output|Where-Object {$_ -is [string]})
 return ($output -join "`n")
}
function Record([string]$Name,$Value){$Value|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $EvidenceDirectory "$Name.json") -Encoding utf8}
function ReadObserverReadiness([string]$BaseUrl='http://127.0.0.1:18998') {
 $totals=@{}
 foreach($entry in @(@{name='tasks';path='/state/tasks?offset=0&limit=1'},@{name='pending';path='/state/authorizations?offset=0&limit=1&filter=pending'})){
  $page=Invoke-RestMethod ($BaseUrl+$entry.path) -NoProxy -TimeoutSec 10
  if($null-eq$page -or $page.items -isnot [array] -or $page.total -isnot [long] -and $page.total -isnot [int] -or $page.total-lt0 -or $page.offset-ne0 -or $page.limit-ne1 -or $page.items.Count-gt1 -or $page.revision -isnot [string]){throw 'DEPLOY_OBSERVER_PAGE_INVALID'}
  $totals[$entry.name]=$page.total
 }
 return @{ready=$true;taskTotal=$totals.tasks;pendingTotal=$totals.pending}
}
function ReadConsoleProof {
 $psi=[Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
 $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 foreach($arg in @('-NoProfile','-File',(Join-Path $PSScriptRoot 'stop-web-console.ps1'),'-ExpectedPid',[string]$ExpectedPid,'-Check')){$psi.ArgumentList.Add($arg)}
 $process=[Diagnostics.Process]::Start($psi);$stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
 $process.WaitForExit();$output=$stdout.GetAwaiter().GetResult();$errorText=$stderr.GetAwaiter().GetResult();$code=$process.ExitCode;$process.Dispose()
 if($code){throw "DEPLOY_CONSOLE_CHECK_FAILED:$errorText"}
 return ($output|ConvertFrom-Json)
}
function ProcessIdentity {
 $current=Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedPid"
 if(-not$current-or$current.CreationDate-ne$original.CreationDate-or$current.CommandLine-ne$original.CommandLine){throw 'DEPLOY_PROCESS_IDENTITY_CHANGED'}
}
function PortOwners([int]$port){@(Get-NetTCPConnection -ErrorAction Stop|Where-Object {$_.State-eq'Listen'-and$_.LocalPort-eq$port}|Select-Object -ExpandProperty OwningProcess -Unique)}
function TestCapturedProcess($identity,$current){
 if(-not$current-or([datetime]$current.CreationDate)-ne([datetime]$identity.CreationDate)){return $false}
 if($current.ProcessId-ne$identity.ProcessId-or($identity.Name-and$current.Name-cne$identity.Name)-or($identity.ExecutablePath-and$current.ExecutablePath-cne$identity.ExecutablePath)-or($identity.CommandLineSha256-and(TextHash $current.CommandLine)-cne$identity.CommandLineSha256)-or($identity.CommandLine-and$current.CommandLine-cne$identity.CommandLine)){throw 'DEPLOY_PROCESS_IDENTITY_CHANGED'}
 return $true
}
function AssertCapturedTree($root,$children){
 $identities=@{};$identities[[string]$root.ProcessId]=$root
 foreach($child in $children){
  $key=[string]$child.ProcessId
  if(-not$child.ProcessId-or-not$child.CreationDate-or$identities.ContainsKey($key)){throw 'DEPLOY_PROCESS_TREE_INVALID'}
  $identities[$key]=$child
 }
 foreach($child in $children){
  $seen=[Collections.Generic.HashSet[int]]::new();$cursor=$child
  while($cursor.ProcessId-ne$root.ProcessId){
   if(-not$seen.Add([int]$cursor.ProcessId)){throw 'DEPLOY_PROCESS_TREE_INVALID'}
   $parent=$identities[[string]$cursor.ParentProcessId]
   if(-not$parent-or([datetime]$cursor.CreationDate)-lt([datetime]$parent.CreationDate)){throw 'DEPLOY_PROCESS_TREE_INVALID'}
   $cursor=$parent
  }
 }
}
function Descendants($root){
 # Capture a single live inventory; ParentPID alone can refer to an earlier incarnation.
 $processes=@(Get-CimInstance Win32_Process -ErrorAction Stop)
 $current=@($processes|Where-Object {$_.ProcessId-eq$root.ProcessId})
 if($current.Count-ne1-or-not(TestCapturedProcess $root $current[0])){throw 'DEPLOY_PROCESS_IDENTITY_CHANGED'}
 $queue=[Collections.Generic.Queue[object]]::new();$queue.Enqueue($root)
 $seen=[Collections.Generic.HashSet[int]]::new();[void]$seen.Add([int]$root.ProcessId)
 $children=[Collections.Generic.List[object]]::new()
 while($queue.Count){
  $parent=$queue.Dequeue()
  foreach($child in $processes|Where-Object {$_.ParentProcessId-eq$parent.ProcessId}){
   if(-not$child.CreationDate){throw 'DEPLOY_PROCESS_TREE_INVALID'}
   if(([datetime]$child.CreationDate)-lt([datetime]$parent.CreationDate)){continue}
   if(-not$seen.Add([int]$child.ProcessId)){throw 'DEPLOY_PROCESS_TREE_INVALID'}
   $identity=[pscustomobject]@{ProcessId=$child.ProcessId;ParentProcessId=$child.ParentProcessId;Name=$child.Name;CreationDate=$child.CreationDate;ExecutablePath=$child.ExecutablePath;CommandLineSha256=$(if($child.CommandLine){TextHash $child.CommandLine}else{$null})}
   $children.Add($identity);$queue.Enqueue($identity)
  }
 }
 AssertCapturedTree $root $children
 return $children.ToArray()
}
function AssertDrainMaintenanceProcessesExited {
 if((TestCapturedProcess $original (Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedPid"))-or(PortOwners 3080).Count-or(PortOwners 18998).Count-or(Get-ScheduledTask -TaskName $taskName).Settings.Enabled){throw 'DEPLOY_MAINTENANCE_PROCESS_REMAINS'}
 AssertCapturedTree $original $originalDescendants
 foreach($child in $originalDescendants){
  $remaining=Get-CimInstance Win32_Process -Filter "ProcessId=$($child.ProcessId)"
  if(TestCapturedProcess $child $remaining){throw 'DEPLOY_CHILD_PROCESS_REMAINS'}
 }
}
function WaitFor([scriptblock]$Condition,[string]$Failure,[int]$TimeoutSeconds=120){
 $deadline=[DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
 do{if(& $Condition){return};Start-Sleep -Milliseconds 500}while([DateTime]::UtcNow-lt$deadline)
 throw $Failure
}
if((Hash $Package)-ne$ExpectedPackageSha256.ToLowerInvariant()){throw 'DEPLOY_PACKAGE_HASH_MISMATCH'}
if([bool]$ObserverPackage -ne [bool]$ExpectedObserverPackageSha256){throw 'DEPLOY_OBSERVER_PACKAGE_PAIR_REQUIRED'}
if($ObserverPackage -and (Hash $ObserverPackage)-ne$ExpectedObserverPackageSha256.ToLowerInvariant()){throw 'DEPLOY_OBSERVER_HASH_MISMATCH'}
if((Hash $patch)-ne$ExpectedProfileSha256.ToLowerInvariant()){throw 'DEPLOY_PROFILE_HASH_MISMATCH'}
$original=Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedPid"
if($ResumeNativeDispose){
 if($PtyUpgradeProposal-or$ArtifactPolicyProposal-or$RestartMaintenanceProposal){throw 'DEPLOY_RESUME_PATCH_UNSUPPORTED'}
 $savedControl=Get-Content (Join-Path $EvidenceDirectory 'control.json') -Raw|ConvertFrom-Json
 $savedSignal=Get-Content (Join-Path $EvidenceDirectory 'signal.json') -Raw|ConvertFrom-Json
 $savedFailure=Get-Content (Join-Path $EvidenceDirectory 'failure.json') -Raw|ConvertFrom-Json
 if($savedControl.pid-ne$ExpectedPid-or$savedControl.packageSha256-ne$ExpectedPackageSha256-or$savedControl.profileSha256-ne$ExpectedProfileSha256-or$savedFailure.phase-ne'native-dispose'-or$savedFailure.error-ne'DEPLOY_NATIVE_NOT_QUIESCENT'-or$savedSignal.targetPid-ne$ExpectedPid-or$savedSignal.signalSent-ne'CTRL_C_EVENT'){throw 'DEPLOY_RESUME_EVIDENCE_MISMATCH'}
 $retainedRoot=[pscustomobject]@{ProcessId=$ExpectedPid;CreationDate=$savedControl.creationDate;Name=$savedControl.name;ExecutablePath=$savedControl.executablePath;CommandLineSha256=$savedControl.commandLineSha256}
 if((TestCapturedProcess $retainedRoot $original)-or(PortOwners 3080).Count-or(PortOwners 18998).Count){throw 'DEPLOY_RESUME_PROCESS_REMAINS'}
 $originalDescendants=@()
 $capturedPath=Join-Path $EvidenceDirectory 'captured-descendants.json'
 if(Test-Path -LiteralPath $capturedPath){
  $originalDescendants=@(Get-Content $capturedPath -Raw|ConvertFrom-Json)
  AssertCapturedTree $retainedRoot $originalDescendants
  foreach($captured in $originalDescendants){
   $remaining=Get-CimInstance Win32_Process -Filter "ProcessId=$($captured.ProcessId)"
   if(TestCapturedProcess $captured $remaining){throw 'DEPLOY_RESUME_CHILD_PROCESS_REMAINS'}
  }
 }
 $original=$retainedRoot
}else{
if(-not$original-or$original.CommandLine-notlike "*--require D:\dsh_home\launchers\web-module-loader.cjs*"-or$original.CommandLine-notlike '*profiles\web\node_modules\@deepseek-ai\dsh\lib\bin.js web --no-open*'){throw 'DEPLOY_UNEXPECTED_PROCESS'}
foreach($port in @(3080,18998)){$owners=PortOwners $port;if($owners.Count-ne1-or$owners[0]-ne$ExpectedPid){throw 'DEPLOY_PORT_IDENTITY_MISMATCH'}}
}
$task=Get-ScheduledTask -TaskName $taskName
$actions=@($task.Actions)
$expectedAction='-NoProfile -WindowStyle Hidden -Command "$env:DSH_HOME=''D:\dsh_home''; & ''D:\dsh_home\launchers\start-web.ps1'' -ProjectRoot ''D:\project\dingtalk-dsh-assistant'' *> ''D:\project\dingtalk-dsh-assistant\docs\tmp\dsh-web-local\web.log''"'
if($actions.Count-ne1-or$actions[0].Execute-ne'C:\Program Files\PowerShell\7\pwsh.exe'-or$actions[0].WorkingDirectory-ne'D:\project\dingtalk-dsh-assistant'-or$actions[0].Arguments-cne$expectedAction-or$task.Settings.RestartCount-ne0){throw 'DEPLOY_SCHEDULED_TASK_IDENTITY'}
$wasEnabled=[bool]$task.Settings.Enabled
$consoleProof=if($ResumeNativeDispose){if($wasEnabled){throw 'DEPLOY_RESUME_AUTOSTART_ENABLED'};$wasEnabled=[bool]$savedControl.taskEnabled;@{resumed=$true;signals=0}}else{ReadConsoleProof}
$packageProof=RunNode @($checker,'package',$Package,(Join-Path $workspace 'packages/dingtalk-dsh-assistant'))
if($ObserverPackage){$observerProof=RunNode @($checker,'package',$ObserverPackage,(Join-Path $workspace 'packages/dingtalk-dsh-observer'))}
$maintenanceArgs=@()
if($RestartMaintenanceProposal){
 $RestartMaintenanceProposal=[IO.Path]::GetFullPath($RestartMaintenanceProposal)
 $maintenanceProposalHash=Hash $RestartMaintenanceProposal
 $maintenanceArgs=@('online',[string]$ExpectedPid,$RestartMaintenanceProposal)
}
if($DrainFailureMaintenanceProposal){
 $DrainFailureMaintenanceProposal=[IO.Path]::GetFullPath($DrainFailureMaintenanceProposal)
 $drainMaintenanceHash=Hash $DrainFailureMaintenanceProposal
 $drainMaintenance=Get-Content -LiteralPath $DrainFailureMaintenanceProposal -Raw|ConvertFrom-Json
 AssertDrainMaintenanceIdentity
}
$ledgerProof=if($RestartMaintenanceProposal){RunNode (@($ledger,$db,$agentWorkspace)+$maintenanceArgs)}elseif($DrainFailureMaintenanceProposal){RunNode @($ledger,'current-control',$db,'online',[string]$ExpectedPid,$agentWorkspace,$DrainFailureMaintenanceProposal)}else{$controlMode=if($ResumeNativeDispose){'offline'}else{'online'};RunNode @($ledger,'current-control',$db,$controlMode,[string]$ExpectedPid)}
if($PtyUpgradeProposal){$ptyProposalSha256=Hash $PtyUpgradeProposal;$ptyCheck=RunNode @($ptyHelper,'check',$profile,$PtyUpgradeProposal);if((Hash $PtyUpgradeProposal)-ne$ptyProposalSha256){throw 'DEPLOY_PTY_PROPOSAL_CHANGED'}}
$artifactPolicyCheck=$null
if($ArtifactPolicyProposal){
 if(-not(Test-Path -LiteralPath $ArtifactPolicyProposal -PathType Leaf)){throw 'DEPLOY_ARTIFACT_POLICY_PROPOSAL_MISSING'}
 $artifactPolicyProposalSha256=Hash $ArtifactPolicyProposal
 $artifactPolicyCheck=RunNode @($artifactPolicyHelper,'check',$profile,$ArtifactPolicyProposal)
 if((Hash $ArtifactPolicyProposal)-ne$artifactPolicyProposalSha256){throw 'DEPLOY_ARTIFACT_POLICY_PROPOSAL_CHANGED'}
}
# 停机前先证明安装CLI可装配；只读help不运行安装，也不输出可能包含凭据的CLI正文。
$previousCliHome=$env:DSH_HOME
try{$env:DSH_HOME='D:/dsh_home';& $node $entry plugin --help *> $null;if($LASTEXITCODE){throw 'DEPLOY_CLI_PREFLIGHT_FAILED'}}finally{$env:DSH_HOME=$previousCliHome}
$observerManifest="$profile/node_modules/@zzusp/dingtalk-dsh-observer/package.json"
$observerHash=Hash $observerManifest
if($ResumeNativeDispose-and$observerHash-ne$savedControl.observerManifestSha256){throw 'DEPLOY_RESUME_OBSERVER_CHANGED'}
if($Check){@{checkOnly=$true;writes=0;signals=0;console=$consoleProof;packageSha256=Hash $Package;profileSha256=Hash $patch;pid=$ExpectedPid;ledger=($ledgerProof|ConvertFrom-Json)}|ConvertTo-Json -Depth 5;exit 0}
if(-not$ResumeNativeDispose){
 if(Test-Path -LiteralPath $EvidenceDirectory){throw 'DEPLOY_EVIDENCE_ALREADY_EXISTS'}
 New-Item -ItemType Directory -Path $EvidenceDirectory|Out-Null
}
$lockPath=Join-Path $workspace 'docs/tmp/task-session-deployment.lock'
$deploymentLock=$null
try{
 [IO.Directory]::CreateDirectory((Split-Path -Parent $lockPath))|Out-Null
 $deploymentLock=[IO.File]::Open($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 if(-not$ResumeNativeDispose){
 Record 'control' @{backupCreated=$false;pid=$ExpectedPid;creationDate=$original.CreationDate;name=$original.Name;executablePath=$original.ExecutablePath;commandLineSha256=(TextHash $original.CommandLine);packageSha256=Hash $Package;profileSha256=Hash $patch;taskEnabled=$wasEnabled;observerManifestSha256=$observerHash;package=($packageProof|ConvertFrom-Json)}
 ProcessIdentity
 if((Hash $patch)-ne$ExpectedProfileSha256.ToLowerInvariant()){throw 'DEPLOY_PROFILE_CHANGED'}
 $phase='disable-autostart';Disable-ScheduledTask -TaskName $taskName|Out-Null
 if((Get-ScheduledTask -TaskName $taskName).Settings.Enabled){throw 'DEPLOY_AUTOSTART_STILL_ENABLED'}
 if($RestartMaintenanceProposal){
  if((Hash $RestartMaintenanceProposal)-ne$maintenanceProposalHash){throw 'DEPLOY_MAINTENANCE_PROPOSAL_CHANGED'}
   Record 'restart-maintenance-preflight' ($ledgerProof|ConvertFrom-Json)
 }
 if($DrainFailureMaintenanceProposal){
  AssertDrainMaintenanceIdentity
  # Re-read the frozen controls immediately before signalling; never refresh the manifest in place.
  $ledgerProof=RunNode @($ledger,'current-control',$db,'online',[string]$ExpectedPid,$agentWorkspace,$DrainFailureMaintenanceProposal)
  Copy-Item -LiteralPath $DrainFailureMaintenanceProposal -Destination (Join-Path $EvidenceDirectory 'drain-maintenance-proposal.json')
  Record 'drain-maintenance-preflight' ($ledgerProof|ConvertFrom-Json)
 }
 $phase='native-dispose'
 ProcessIdentity
 $originalDescendants=@(Descendants $original)
 Record 'captured-descendants' $originalDescendants
 $signalOut=Join-Path $EvidenceDirectory 'signal.json';$signalErr=Join-Path $EvidenceDirectory 'signal.stderr.log'
 $signalArgs=@('-NoProfile','-File',(Join-Path $PSScriptRoot 'stop-web-console.ps1'),'-ExpectedPid',[string]$ExpectedPid)
 $signaler=Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList $signalArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput $signalOut -RedirectStandardError $signalErr
 $signaler.WaitForExit();if($signaler.ExitCode){throw 'DEPLOY_NATIVE_SIGNAL_FAILED'}
 WaitFor {
  if(TestCapturedProcess $original (Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedPid")){return $false}
  foreach($child in $originalDescendants){
   $remaining=Get-CimInstance Win32_Process -Filter "ProcessId=$($child.ProcessId)"
   if(TestCapturedProcess $child $remaining){return $false}
  }
  if((PortOwners 3080).Count-or(PortOwners 18998).Count){return $false}
  try{$offlineArgs=if($RestartMaintenanceProposal){@($ledger,$db,$agentWorkspace,'offline',[string]$ExpectedPid,$RestartMaintenanceProposal)}elseif($DrainFailureMaintenanceProposal){@($ledger,'current-control',$db,'offline',[string]$ExpectedPid,$agentWorkspace,$DrainFailureMaintenanceProposal)}else{@($ledger,'current-control',$db,'offline',[string]$ExpectedPid)};$script:offlineProof=RunNode $offlineArgs;return $true}catch{if($DrainFailureMaintenanceProposal){throw};return $false}
 } 'DEPLOY_NATIVE_NOT_QUIESCENT'
 AssertCapturedTree $original $originalDescendants
 }else{
  if((Hash $patch)-ne$ExpectedProfileSha256.ToLowerInvariant()-or(Get-ScheduledTask -TaskName $taskName).Settings.Enabled-or(TestCapturedProcess $original (Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedPid"))-or(PortOwners 3080).Count-or(PortOwners 18998).Count){throw 'DEPLOY_RESUME_STATE_CHANGED'}
  $offlineProof=RunNode @($ledger,'current-control',$db,'offline',[string]$ExpectedPid)
  Record 'resume-native-dispose' @{observedAt=[DateTime]::UtcNow.ToString('o');priorFailure=$savedFailure;signals=0}
 }
 if($DrainFailureMaintenanceProposal){AssertDrainMaintenanceProcessesExited}
 Record 'quiescent' @{ledger=($offlineProof|ConvertFrom-Json);pid=$ExpectedPid;creationDate=$original.CreationDate;remainingDescendants=0;runtimePortClosed=$true;observedAt=[DateTime]::UtcNow.ToString('o');shutdown='SIGINT'}
 if($DrainFailureMaintenanceProposal){
  AssertDrainMaintenanceIdentity
  $beforeMaintenance=($ledgerProof|ConvertFrom-Json).maintenance
  $afterMaintenance=($offlineProof|ConvertFrom-Json).maintenance
  if(-not$beforeMaintenance-or-not$afterMaintenance-or$beforeMaintenance.ledgerDigest-ne$afterMaintenance.ledgerDigest-or$beforeMaintenance.proposalDigest-ne$afterMaintenance.proposalDigest){throw 'DEPLOY_RETAINED_LEDGER_CHANGED'}
  Record 'drain-maintenance-cutover' @{maintenance=$afterMaintenance;drained=$false;processesExited=$true;recoveryRequired=$true;replayAllowed=$false}
 }
 if($RestartMaintenanceProposal){
  if((Hash $RestartMaintenanceProposal)-ne$maintenanceProposalHash){throw 'DEPLOY_MAINTENANCE_PROPOSAL_CHANGED'}
  $beforeMaintenance=($ledgerProof|ConvertFrom-Json).maintenance
  $afterMaintenance=($offlineProof|ConvertFrom-Json).maintenance
  if($beforeMaintenance.ledgerDigest-ne$afterMaintenance.ledgerDigest){throw 'DEPLOY_RETAINED_LEDGER_CHANGED'}
  $phase='backup'
  $backupDirectory=Join-Path $EvidenceDirectory 'backup';New-Item -ItemType Directory -Path $backupDirectory|Out-Null
  $backupProof=RunNode @((Join-Path $workspace 'scripts/backup-native-maintenance.mjs'),$db,(Join-Path $backupDirectory 'task-sessions.sqlite'))
  foreach($file in @($patch,"$profile/package.json","$profile/pnpm-lock.yaml",$starter,"$db.initialized")){
   if(Test-Path -LiteralPath $file -PathType Leaf){Copy-Item -LiteralPath $file -Destination (Join-Path $backupDirectory ([IO.Path]::GetFileName($file)))}
  }
  Record 'backup' ($backupProof|ConvertFrom-Json)
 }
 $phase='install'
 if($DrainFailureMaintenanceProposal){
  AssertDrainMaintenanceIdentity
  AssertDrainMaintenanceProcessesExited
  $offlineProof=RunNode @($ledger,'current-control',$db,'offline',[string]$ExpectedPid,$agentWorkspace,$DrainFailureMaintenanceProposal)
 }
 $assistantInstallPackage=ImmutablePackage $Package $ExpectedPackageSha256
 $observerInstallPackage=ImmutablePackage $ObserverPackage $ExpectedObserverPackageSha256
 $installationPolicyProposal=$ArtifactPolicyProposal
 if($ArtifactPolicyProposal){
  if((Hash $ArtifactPolicyProposal)-ne$artifactPolicyProposalSha256){throw 'DEPLOY_ARTIFACT_POLICY_PROPOSAL_CHANGED'}
  $policyInput=Get-Content -LiteralPath $ArtifactPolicyProposal -Raw|ConvertFrom-Json
  $policyInput.packagePath=ImmutablePackage $policyInput.packagePath $policyInput.packageSha256
  $installationPolicyProposal=Join-Path $EvidenceDirectory 'artifact-policy-install-proposal.json'
  $policyInput|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $installationPolicyProposal
 }
 if($PtyUpgradeProposal){if((Hash $PtyUpgradeProposal)-ne$ptyProposalSha256){throw 'DEPLOY_PTY_PROPOSAL_CHANGED'};Record 'pty-manifest-applied' ((RunNode @($ptyHelper,'apply',$profile,$PtyUpgradeProposal))|ConvertFrom-Json)}
 if($ArtifactPolicyProposal){
  if((Hash $ArtifactPolicyProposal)-ne$artifactPolicyProposalSha256){throw 'DEPLOY_ARTIFACT_POLICY_PROPOSAL_CHANGED'}
  Record 'artifact-policy-manifest-applied' ((RunNode @($artifactPolicyHelper,'apply',$profile,$installationPolicyProposal))|ConvertFrom-Json)
 }
 if((Hash $Package)-ne$ExpectedPackageSha256.ToLowerInvariant()){throw 'DEPLOY_PACKAGE_CHANGED'}
 # 官方CLI输出可能带登录链接，仅保留退出码；失败现场保留停机和禁用状态。
 $previousDshHome=$env:DSH_HOME
 try{
  $env:DSH_HOME='D:/dsh_home'
  $installPackages=@("@zzusp/dingtalk-dsh-assistant@file:$assistantInstallPackage")
  if($ObserverPackage){
   if((Hash $ObserverPackage)-ne$ExpectedObserverPackageSha256.ToLowerInvariant()){throw 'DEPLOY_OBSERVER_PACKAGE_CHANGED'}
   $installPackages+="@zzusp/dingtalk-dsh-observer@file:$observerInstallPackage"
  }
  if($ArtifactPolicyProposal){
   $policyInput=Get-Content -LiteralPath $installationPolicyProposal -Raw|ConvertFrom-Json
   $installPackages+="@deepseek-ai/dsh-sandbox-policy@file:$($policyInput.packagePath)"
  }
  & $node $entry plugin --profile web add @installPackages *> $null;$installExit=$LASTEXITCODE
 }
 finally{$env:DSH_HOME=$previousDshHome}
 if($installExit){throw 'DEPLOY_PACKAGE_INSTALL_FAILED'}
 if($PtyUpgradeProposal){if((Hash $PtyUpgradeProposal)-ne$ptyProposalSha256){throw 'DEPLOY_PTY_PROPOSAL_CHANGED'};Record 'pty-installed' ((RunNode @($ptyHelper,'verify',$profile,$PtyUpgradeProposal))|ConvertFrom-Json)}
 if($ArtifactPolicyProposal){
  if((Hash $ArtifactPolicyProposal)-ne$artifactPolicyProposalSha256){throw 'DEPLOY_ARTIFACT_POLICY_PROPOSAL_CHANGED'}
  Record 'artifact-policy-installed' ((RunNode @($artifactPolicyHelper,'verify',$profile,$installationPolicyProposal))|ConvertFrom-Json)
 }
 $installedProof=RunNode @($checker,'package',$Package,(Join-Path $workspace 'packages/dingtalk-dsh-assistant'),$installed)
 if((Hash $patch)-ne$ExpectedProfileSha256.ToLowerInvariant()){throw 'DEPLOY_INSTALL_CHANGED_UNRELATED_INPUT'}
 Record 'installed' ($installedProof|ConvertFrom-Json)
 if($ObserverPackage){Record 'observer-installed' ((RunNode @($checker,'package',$ObserverPackage,(Join-Path $workspace 'packages/dingtalk-dsh-observer'),"$profile/node_modules/@zzusp/dingtalk-dsh-observer"))|ConvertFrom-Json)}
 $phase='verify-profile'
 if((Hash $patch)-ne$ExpectedProfileSha256.ToLowerInvariant()){throw 'DEPLOY_PROFILE_RESTORE_MISMATCH'}
 if($wasEnabled){Enable-ScheduledTask -TaskName $taskName|Out-Null}
 $phase='start';Start-ScheduledTask -TaskName $taskName
 # The installed cold profile graph can take over five minutes; retain a bounded wait.
 WaitFor {$owners=PortOwners 18998;if($owners.Count-ne1-or$owners[0]-eq$ExpectedPid){return $false};$script:newPid=$owners[0];return (PortOwners 3080)-contains$newPid} 'DEPLOY_NEW_PROCESS_NOT_READY' 600
 WaitFor {
  try{$script:health=Invoke-RestMethod http://127.0.0.1:18998/health -NoProxy -TimeoutSec 10;return $health.inboundProcessing -and $health.dwsBridge.healthy}catch{return $false}
 } 'DEPLOY_TRANSPORT_NOT_READY' 60
 $phase='observer-readiness'
 Record 'observer-readiness' (ReadObserverReadiness)
 Record 'readback' @{newPid=$newPid;creationDate=(Get-CimInstance Win32_Process -Filter "ProcessId=$newPid").CreationDate;health=$health;profileSha256=Hash $patch;packageSha256=Hash $Package;installedVersion=(Get-Content "$installed/package.json" -Raw|ConvertFrom-Json).version;taskEnabled=(Get-ScheduledTask -TaskName $taskName).Settings.Enabled;backupCreated=[bool]$RestartMaintenanceProposal}
 @{installed=$true;transportReady=$true;newPid=$newPid;health=$health.status;recoveryIssueCount=$health.recoveryIssueCount;evidenceDirectory=$EvidenceDirectory}|ConvertTo-Json
}catch{
 Record 'failure' @{phase=$phase;error=$_.Exception.Message;profileSha256=Hash $patch;autostartEnabled=(Get-ScheduledTask -TaskName $taskName).Settings.Enabled}
 throw
}finally{
 if($deploymentLock){$deploymentLock.Dispose();Remove-Item -LiteralPath $lockPath}
}
