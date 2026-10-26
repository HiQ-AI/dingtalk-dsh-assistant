param([switch]$Check)
$ErrorActionPreference='Stop'
# Read-only live follow-up of the original deployment; never installs or restarts.
$profile='D:/dsh_home/profiles/web'
$packageRoot='D:/dsh_home/packages/coordinator-work-22d5738'
$patch='74fe100c0019f5e4c76c06903fdb622b0af5696afc60ab38cbd252ce8f948499'
$expected=@{assistant='77eea78e705ee62085afc31baab956ce2f61d2f0dc8ad09dba98c2280c0fa2a9';observer='b5a468c15c4c11c757a3275887a72e8c65a2bdf438f2266f2d64514ec9f135cd'}
$packages=@{}
$manifest=Get-Content "$profile/package.json" -Raw|ConvertFrom-Json
foreach($kind in @('assistant','observer')){
 $name="@zzusp/dingtalk-dsh-$kind"
 $file="$packageRoot/zzusp-dingtalk-dsh-$kind-2.1.0.tgz"
 $sha=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
 if($sha-ne$expected[$kind]){throw 'READBACK_PACKAGE_CHANGED'}
 $dependency=$manifest.dependencies.$name
 if($dependency-ne"file:$file"){throw 'READBACK_INSTALLED_DEPENDENCY_CHANGED'}
 $version=(Get-Content "$profile/node_modules/$name/package.json" -Raw|ConvertFrom-Json).version
 if($version-ne'2.1.0'){throw 'READBACK_VERSION_CHANGED'}
 $packages[$kind]=@{version=$version;sha256=$sha;bytes=(Get-Item -LiteralPath $file).Length;installedDependency=$dependency}
}
$actualPatch=(Get-FileHash "$profile/cordis.patch.yml").Hash.ToLowerInvariant()
if($actualPatch-ne$patch){throw 'READBACK_PROFILE_CHANGED'}
$ports=@(Get-NetTCPConnection -State Listen -LocalPort 3080,18998|Select-Object LocalPort,OwningProcess)
if($ports.Count-ne2-or@($ports|Where-Object OwningProcess -ne 91732).Count){throw 'READBACK_PROCESS_CHANGED'}
$process=Get-CimInstance Win32_Process -Filter 'ProcessId=91732'
if(-not$process-or$process.ParentProcessId-ne93000-or$process.CommandLine-notlike '*profiles\web\node_modules\@deepseek-ai\dsh\lib\bin.js web --no-open*'){throw 'READBACK_PROCESS_IDENTITY_CHANGED'}
if(Get-Process -Id 84680 -ErrorAction SilentlyContinue){throw 'READBACK_OLD_PROCESS_ALIVE'}
$health=Invoke-RestMethod http://127.0.0.1:18998/health -NoProxy -TimeoutSec 15
if($health.status-ne'ok'-or$health.recoveryIssueCount-ne0-or-not$health.inboundProcessing-or-not$health.dwsBridge.healthy){throw 'READBACK_HEALTH_NOT_READY'}
$task=Get-ScheduledTask -TaskName 'DSH Web Local'
if(-not$task.Settings.Enabled){throw 'READBACK_AUTOSTART_DISABLED'}
$maintenanceCode=$null
try{$null=Invoke-RestMethod http://127.0.0.1:18998/runtime/maintenance -NoProxy -TimeoutSec 10;throw 'READBACK_MAINTENANCE_CONTRACT_CHANGED'}catch{
 if([int]$_.Exception.Response.StatusCode-ne404){throw}
 $body=$_.ErrorDetails.Message|ConvertFrom-Json
 if($body.error-ne'workflow_maintenance_unavailable'){throw 'READBACK_MAINTENANCE_CONTRACT_CHANGED'}
 $maintenanceCode=$body.error
}
$webVerifier=Join-Path $PSScriptRoot '../../dsh-unified-upgrade/scripts/verify-native-web.mjs'
$web=& node $webVerifier --log D:/project/dingtalk-dsh-assistant/docs/tmp/dsh-web-local/web.log
if($LASTEXITCODE){throw 'READBACK_AUTHENTICATED_WEB_FAILED'}
$web=$web|ConvertFrom-Json
@{observedAt=[DateTime]::UtcNow.ToString('o');checkOnly=[bool]$Check;writes=0;installs=0;restarts=0;
 originalOperation='ba4b7mvd9';originalExit=1;originalFailure='DEPLOY_NEW_PROCESS_NOT_READY';originalPhase='start';
 followup='Same original new process became ready after five-minute wait expired; no reinstall/restart';
 mergeCommit='22d57386ebb5a11b89ab30e461a0b95e7bfc7f53';oldPid=84680;oldProcessExited=$true;
 newPid=$process.ProcessId;parentPid=$process.ParentProcessId;newCreationDate=$process.CreationDate;ports=$ports;packages=$packages;
 hostVersion=(Get-Content "$profile/node_modules/@deepseek-ai/dsh/package.json" -Raw|ConvertFrom-Json).version;
 profileSha256=$actualPatch;autostartEnabled=$task.Settings.Enabled;taskState=[string]$task.State;
 health=@{status=$health.status;recoveryIssueCount=$health.recoveryIssueCount;inboundProcessing=$health.inboundProcessing;
 bridgeHealthy=$health.dwsBridge.healthy;listeners=@($health.dwsBridge.groups|ForEach-Object {$_.listener.state});
 backfills=@($health.dwsBridge.groups|ForEach-Object {$_.backfill.state});humanReplies=$health.dwsBridge.humanReplies.state};
 authenticatedWeb=$web;maintenance=@{status=404;code=$maintenanceCode;resume='Not applicable to retired workflow API; native lifecycle restored inbound and autostart'};
 backupCreated=$false}|ConvertTo-Json -Depth 6
