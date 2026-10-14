param(
 [switch]$Check,
 [Parameter(Mandatory)][string]$Package,
 [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedPackageSha256,
 [Parameter(Mandatory)][int]$ExpectedPid,
 [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedProfileSha256,
 [Parameter(Mandatory)][string]$EvidenceDirectory,
 [string]$ObserverPackage,
 [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedObserverPackageSha256
)
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$profile='D:/dsh_home/profiles/web'
$patch="$profile/cordis.patch.yml"
$agentWorkspace='D:/baibu-agent/task-session-runtime-clean'
$db="$agentWorkspace/.dsh/task-sessions.sqlite"
$node='D:/soft/node-v24.19.0/node.exe'
$starter='D:/dsh_home/launchers/start-web.ps1'
$entry="$profile/node_modules/@deepseek-ai/dsh/lib/bin.js"
$installed="$profile/node_modules/@zzusp/dingtalk-dsh-assistant"
$checker=Join-Path $PSScriptRoot 'inspect-quiescent-ledger.mjs'
$ledger=Join-Path $PSScriptRoot 'inspect-quiescent-ledger.mjs'
$taskName='DSH Web Local'
$phase='check'
function Hash([string]$file){(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
function RunNode([string[]]$Arguments){
 $output=& $node @Arguments 2>$null
 if($LASTEXITCODE){throw "DEPLOY_NODE_CHECK_FAILED:$($Arguments[0]):$($Arguments[1])"}
 return ($output -join "`n")
}
function Record([string]$Name,$Value){$Value|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $EvidenceDirectory "$Name.json") -Encoding utf8}
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
function PortOwners([int]$port){@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue|Select-Object -ExpandProperty OwningProcess -Unique)}
function Descendants([int]$parent){
 $direct=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent")
 foreach($child in $direct){$child;Descendants $child.ProcessId}
}
function WaitFor([scriptblock]$Condition,[string]$Failure){
 $deadline=[DateTime]::UtcNow.AddSeconds(120)
 do{if(& $Condition){return};Start-Sleep -Milliseconds 500}while([DateTime]::UtcNow-lt$deadline)
 throw $Failure
}
if((Hash $Package)-ne$ExpectedPackageSha256.ToLowerInvariant()){throw 'DEPLOY_PACKAGE_HASH_MISMATCH'}
if([bool]$ObserverPackage -ne [bool]$ExpectedObserverPackageSha256){throw 'DEPLOY_OBSERVER_PACKAGE_PAIR_REQUIRED'}
if($ObserverPackage -and (Hash $ObserverPackage)-ne$ExpectedObserverPackageSha256.ToLowerInvariant()){throw 'DEPLOY_OBSERVER_HASH_MISMATCH'}
if((Hash $patch)-ne$ExpectedProfileSha256.ToLowerInvariant()){throw 'DEPLOY_PROFILE_HASH_MISMATCH'}
$original=Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedPid"
if(-not$original-or$original.CommandLine-notlike "*--require D:\dsh_home\launchers\web-module-loader.cjs*"-or$original.CommandLine-notlike '*profiles\web\node_modules\@deepseek-ai\dsh\lib\bin.js web --no-open*'){throw 'DEPLOY_UNEXPECTED_PROCESS'}
foreach($port in @(3080,18998)){$owners=PortOwners $port;if($owners.Count-ne1-or$owners[0]-ne$ExpectedPid){throw 'DEPLOY_PORT_IDENTITY_MISMATCH'}}
$task=Get-ScheduledTask -TaskName $taskName
$actions=@($task.Actions)
$expectedAction='-NoProfile -WindowStyle Hidden -Command "$env:DSH_HOME=''D:\dsh_home''; & ''D:\dsh_home\launchers\start-web.ps1'' -ProjectRoot ''D:\project\dingtalk-dsh-assistant'' *> ''D:\project\dingtalk-dsh-assistant\docs\tmp\dsh-web-local\web.log''"'
if($actions.Count-ne1-or$actions[0].Execute-ne'C:\Program Files\PowerShell\7\pwsh.exe'-or$actions[0].WorkingDirectory-ne'D:\project\dingtalk-dsh-assistant'-or$actions[0].Arguments-cne$expectedAction-or$task.Settings.RestartCount-ne0){throw 'DEPLOY_SCHEDULED_TASK_IDENTITY'}
$wasEnabled=[bool]$task.Settings.Enabled
$consoleProof=ReadConsoleProof
$packageProof=RunNode @($checker,'package',$Package,(Join-Path $workspace 'packages/dingtalk-dsh-assistant'))
if($ObserverPackage){$observerProof=RunNode @($checker,'package',$ObserverPackage,(Join-Path $workspace 'packages/dingtalk-dsh-observer'))}
$ledgerProof=RunNode @($ledger,$db,$agentWorkspace)
$observerManifest="$profile/node_modules/@zzusp/dingtalk-dsh-observer/package.json"
$observerHash=Hash $observerManifest
if($Check){@{checkOnly=$true;writes=0;signals=0;console=$consoleProof;packageSha256=Hash $Package;profileSha256=Hash $patch;pid=$ExpectedPid;ledger=($ledgerProof|ConvertFrom-Json)}|ConvertTo-Json -Depth 5;exit 0}
if(Test-Path -LiteralPath $EvidenceDirectory){throw 'DEPLOY_EVIDENCE_ALREADY_EXISTS'}
New-Item -ItemType Directory -Path $EvidenceDirectory|Out-Null
$lockPath=Join-Path $workspace 'docs/tmp/task-session-deployment.lock'
$deploymentLock=$null
try{
 $deploymentLock=[IO.File]::Open($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 Record 'control' @{backupCreated=$false;pid=$ExpectedPid;creationDate=$original.CreationDate;packageSha256=Hash $Package;profileSha256=Hash $patch;taskEnabled=$wasEnabled;observerManifestSha256=$observerHash;package=($packageProof|ConvertFrom-Json)}
 ProcessIdentity
 if((Hash $patch)-ne$ExpectedProfileSha256.ToLowerInvariant()){throw 'DEPLOY_PROFILE_CHANGED'}
 $phase='disable-autostart';Disable-ScheduledTask -TaskName $taskName|Out-Null
 if((Get-ScheduledTask -TaskName $taskName).Settings.Enabled){throw 'DEPLOY_AUTOSTART_STILL_ENABLED'}
 $phase='native-dispose'
 $signalOut=Join-Path $EvidenceDirectory 'signal.json';$signalErr=Join-Path $EvidenceDirectory 'signal.stderr.log'
 $signalArgs=@('-NoProfile','-File',(Join-Path $PSScriptRoot 'stop-web-console.ps1'),'-ExpectedPid',[string]$ExpectedPid)
 $signaler=Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList $signalArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput $signalOut -RedirectStandardError $signalErr
 $signaler.WaitForExit();if($signaler.ExitCode){throw 'DEPLOY_NATIVE_SIGNAL_FAILED'}
 WaitFor {
  if(Get-Process -Id $ExpectedPid -ErrorAction SilentlyContinue){return $false}
  if((PortOwners 3080).Count-or(PortOwners 18998).Count){return $false}
  try{$script:offlineProof=RunNode @($ledger,$db,$agentWorkspace,'offline');return $true}catch{return $false}
 } 'DEPLOY_NATIVE_NOT_QUIESCENT'
 if(@(Descendants $ExpectedPid).Count){throw 'DEPLOY_CHILD_PROCESS_REMAINS'}
 Record 'quiescent' @{ledger=($offlineProof|ConvertFrom-Json);pid=$ExpectedPid;creationDate=$original.CreationDate;remainingDescendants=0;runtimePortClosed=$true;observedAt=[DateTime]::UtcNow.ToString('o');shutdown='SIGINT'}
 $phase='install'
 if((Hash $Package)-ne$ExpectedPackageSha256.ToLowerInvariant()){throw 'DEPLOY_PACKAGE_CHANGED'}
 # 官方CLI输出可能带登录链接，仅保留退出码；失败现场保留停机和禁用状态。
 $previousDshHome=$env:DSH_HOME
 try{
  $env:DSH_HOME='D:/dsh_home'
  $installPackages=@("@zzusp/dingtalk-dsh-assistant@file:$Package")
  if($ObserverPackage){
   if((Hash $ObserverPackage)-ne$ExpectedObserverPackageSha256.ToLowerInvariant()){throw 'DEPLOY_OBSERVER_PACKAGE_CHANGED'}
   $installPackages+="@zzusp/dingtalk-dsh-observer@file:$ObserverPackage"
  }
  & $node $entry plugin --profile web add @installPackages *> $null;$installExit=$LASTEXITCODE
 }
 finally{$env:DSH_HOME=$previousDshHome}
 if($installExit){throw 'DEPLOY_PACKAGE_INSTALL_FAILED'}
 $installedProof=RunNode @($checker,'package',$Package,(Join-Path $workspace 'packages/dingtalk-dsh-assistant'),$installed)
 if((Hash $patch)-ne$ExpectedProfileSha256.ToLowerInvariant()-or(Hash $observerManifest)-ne$observerHash){throw 'DEPLOY_INSTALL_CHANGED_UNRELATED_INPUT'}
 Record 'installed' ($installedProof|ConvertFrom-Json)
 if($ObserverPackage){Record 'observer-installed' ((RunNode @($checker,'package',$ObserverPackage,(Join-Path $workspace 'packages/dingtalk-dsh-observer'),"$profile/node_modules/@zzusp/dingtalk-dsh-observer"))|ConvertFrom-Json)}
 $phase='verify-profile'
 if((Hash $patch)-ne$ExpectedProfileSha256.ToLowerInvariant()){throw 'DEPLOY_PROFILE_RESTORE_MISMATCH'}
 if($wasEnabled){Enable-ScheduledTask -TaskName $taskName|Out-Null}
 $phase='start';Start-ScheduledTask -TaskName $taskName
 WaitFor {$owners=PortOwners 18998;if($owners.Count-ne1-or$owners[0]-eq$ExpectedPid){return $false};$script:newPid=$owners[0];return (PortOwners 3080)-contains$newPid} 'DEPLOY_NEW_PROCESS_NOT_READY'
 $health=Invoke-RestMethod http://127.0.0.1:18998/health -NoProxy -TimeoutSec 10
 Record 'readback' @{newPid=$newPid;creationDate=(Get-CimInstance Win32_Process -Filter "ProcessId=$newPid").CreationDate;health=$health;profileSha256=Hash $patch;packageSha256=Hash $Package;installedVersion=(Get-Content "$installed/package.json" -Raw|ConvertFrom-Json).version;taskEnabled=(Get-ScheduledTask -TaskName $taskName).Settings.Enabled;backupCreated=$false}
 if(-not $health.inboundProcessing -or -not $health.dwsBridge.healthy){throw 'DEPLOY_TRANSPORT_NOT_READY'}
 @{installed=$true;transportReady=$true;newPid=$newPid;health=$health.status;recoveryIssueCount=$health.recoveryIssueCount;evidenceDirectory=$EvidenceDirectory}|ConvertTo-Json
}catch{
 Record 'failure' @{phase=$phase;error=$_.Exception.Message;profileSha256=Hash $patch;autostartEnabled=(Get-ScheduledTask -TaskName $taskName).Settings.Enabled}
 throw
}finally{
 if($deploymentLock){$deploymentLock.Dispose();Remove-Item -LiteralPath $lockPath}
}
