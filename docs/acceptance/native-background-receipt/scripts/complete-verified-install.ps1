param([switch]$Check)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$round="$root/docs/acceptance/native-background-receipt/round-4"
$deploymentInput=Get-Content "$round/inputs-2.json" -Raw|ConvertFrom-Json
$control=Get-Content "$round/deployment-2/control.json" -Raw|ConvertFrom-Json
$failure=Get-Content "$round/deployment-2/failure.json" -Raw|ConvertFrom-Json
if($failure.phase-ne'install'-or$failure.error-ne'DEPLOY_INSTALL_CHANGED_UNRELATED_INPUT'){throw 'INSTALL_RECOVERY_NOT_APPLICABLE'}
if(Get-Process -Id $deploymentInput.ExpectedPid -ErrorAction SilentlyContinue){throw 'OLD_PROCESS_STILL_LIVE'}
if((Get-FileHash D:/dsh_home/profiles/web/cordis.patch.yml).Hash.ToLowerInvariant()-ne$deploymentInput.ExpectedProfileSha256){throw 'PROFILE_CHANGED'}
$checker="$root/docs/acceptance/task-session-runtime-repair/scripts/inspect-quiescent-ledger.mjs"
foreach($item in @(@('assistant',$deploymentInput.Package,$deploymentInput.ExpectedPackageSha256),@('observer',$deploymentInput.ObserverPackage,$deploymentInput.ExpectedObserverPackageSha256))){
 if((Get-FileHash -LiteralPath $item[1]).Hash.ToLowerInvariant()-ne$item[2]){throw 'PACKAGE_CHANGED'}
 $proof=& node $checker package $item[1] "$root/packages/dingtalk-dsh-$($item[0])" "D:/dsh_home/profiles/web/node_modules/@zzusp/dingtalk-dsh-$($item[0])"
 if($LASTEXITCODE){throw 'INSTALLED_PACKAGE_MISMATCH'}
}
& node $checker D:/baibu-agent/.dsh/task-sessions.sqlite D:/baibu-agent offline ([string]$deploymentInput.ExpectedPid) > $null
if($LASTEXITCODE){throw 'RUNTIME_NOT_OFFLINE'}
if(Get-NetTCPConnection -State Listen -LocalPort 3080,18998 -ErrorAction SilentlyContinue){throw 'RUNTIME_PORT_IN_USE'}
if((Get-ScheduledTask -TaskName 'DSH Web Local').Settings.Enabled){throw 'AUTOSTART_STATE_CHANGED'}
if($Check){@{checkOnly=$true;writes=0;signals=0;installedPackagesVerified=$true;oldProcessExited=$true;profileUnchanged=$true}|ConvertTo-Json;exit}
if($control.taskEnabled){Enable-ScheduledTask -TaskName 'DSH Web Local'|Out-Null}
Start-ScheduledTask -TaskName 'DSH Web Local'
$deadline=[DateTime]::UtcNow.AddSeconds(120)
do{
 try{
  $health=Invoke-RestMethod http://127.0.0.1:18998/health -NoProxy -TimeoutSec 3
  $owners=@(Get-NetTCPConnection -State Listen -LocalPort 18998,3080|Select-Object -ExpandProperty OwningProcess -Unique)
  if($owners.Count-eq1-and$owners[0]-ne$deploymentInput.ExpectedPid-and$health.inboundProcessing-and$health.dwsBridge.healthy){
   $result=@{newPid=$owners[0];packageSha256=$deploymentInput.ExpectedPackageSha256;observerPackageSha256=$deploymentInput.ExpectedObserverPackageSha256;profileSha256=$deploymentInput.ExpectedProfileSha256;health=$health;installedPackagesVerified=$true;reinstalled=$false;taskEnabled=(Get-ScheduledTask -TaskName 'DSH Web Local').Settings.Enabled}
   $result|ConvertTo-Json -Depth 8|Set-Content "$round/recovered-start.json" -Encoding utf8
   @{started=$true;newPid=$owners[0];health=$health.status;recoveryIssueCount=$health.recoveryIssueCount;reinstalled=$false}|ConvertTo-Json;exit
  }
 }catch{}
 Start-Sleep -Milliseconds 500
}while([DateTime]::UtcNow-lt$deadline)
throw 'VERIFIED_INSTALL_START_NOT_READY'
