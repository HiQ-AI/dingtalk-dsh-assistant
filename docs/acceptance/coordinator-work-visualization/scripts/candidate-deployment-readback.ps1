# Read-only candidate verification. Historical round-6 pins remain in native-deployment-readback.ps1.
param(
 [switch]$Check,
 [Parameter(Mandatory)][int]$ExpectedPid,
 [Parameter(Mandatory)][int]$OldPid,
 [Parameter(Mandatory)][string]$PackageRoot,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$AssistantSha256,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ObserverSha256,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ProfileSha256
)
$ErrorActionPreference='Stop'
$profile='D:/dsh_home/profiles/web'
$manifest=Get-Content "$profile/package.json" -Raw | ConvertFrom-Json
$packages=@{}
foreach($kind in @('assistant','observer')){
 $name="@zzusp/dingtalk-dsh-$kind"
 $file=Join-Path $PackageRoot "zzusp-dingtalk-dsh-$kind-2.1.0.tgz"
 $expected=if($kind-eq'assistant'){$AssistantSha256}else{$ObserverSha256}
 $sha=(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()
 if($sha-ne$expected){throw 'CANDIDATE_PACKAGE_HASH_CHANGED'}
 if($manifest.dependencies.$name-ne"file:$($file.Replace('\','/'))"){throw 'CANDIDATE_DEPENDENCY_CHANGED'}
 $version=(Get-Content "$profile/node_modules/$name/package.json" -Raw|ConvertFrom-Json).version
 if($version-ne'2.1.0'){throw 'CANDIDATE_INSTALLED_VERSION_CHANGED'}
 $packages[$kind]=@{version=$version;sha256=$sha;bytes=(Get-Item -LiteralPath $file).Length;dependency=$manifest.dependencies.$name}
}
$actualProfile=(Get-FileHash "$profile/cordis.patch.yml").Hash.ToLowerInvariant()
if($actualProfile-ne$ProfileSha256){throw 'CANDIDATE_PROFILE_CHANGED'}
$ports=@(Get-NetTCPConnection -State Listen -LocalPort 3080,18998|Select-Object LocalPort,OwningProcess)
if($ports.Count-ne2-or@($ports|Where-Object OwningProcess -ne $ExpectedPid).Count){throw 'CANDIDATE_PORT_OWNER_CHANGED'}
$process=Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedPid"
if(-not$process-or$process.CommandLine-notlike '*profiles\web\node_modules\@deepseek-ai\dsh\lib\bin.js web --no-open*'){throw 'CANDIDATE_PROCESS_CHANGED'}
if(Get-Process -Id $OldPid -ErrorAction SilentlyContinue){throw 'CANDIDATE_OLD_PROCESS_ALIVE'}
$hostVersion=(Get-Content "$profile/node_modules/@deepseek-ai/dsh/package.json" -Raw|ConvertFrom-Json).version
if($hostVersion-ne'0.2.1-rc.2'){throw 'CANDIDATE_HOST_CHANGED'}
$task=Get-ScheduledTask -TaskName 'DSH Web Local'
if(-not$task.Settings.Enabled-or$task.State-ne'Running'){throw 'CANDIDATE_AUTOSTART_NOT_RESTORED'}
$health=Invoke-RestMethod http://127.0.0.1:18998/health -NoProxy -TimeoutSec 20
if($health.status-ne'ok'-or$health.recoveryIssueCount-ne0-or-not$health.inboundProcessing-or-not$health.dwsBridge.healthy){throw 'CANDIDATE_HEALTH_NOT_READY'}
$listeners=@($health.dwsBridge.groups|ForEach-Object {$_.listener.state})
$backfills=@($health.dwsBridge.groups|ForEach-Object {$_.backfill.state})
if(@($listeners|Where-Object {$_-ne'ready'}).Count-or@($backfills|Where-Object {$_-ne'ok'}).Count){throw 'CANDIDATE_BRIDGE_NOT_READY'}
$verifier=Join-Path $PSScriptRoot '../../dsh-unified-upgrade/scripts/verify-native-web.mjs'
$web=& node $verifier --log D:/project/dingtalk-dsh-assistant/docs/tmp/dsh-web-local/web.log
if($LASTEXITCODE){throw 'CANDIDATE_AUTHENTICATED_WEB_FAILED'}
$web=$web|ConvertFrom-Json
$sources=Invoke-RestMethod 'http://127.0.0.1:18998/state/coordination-sources?limit=100' -NoProxy -TimeoutSec 20
@{observedAt=[DateTime]::UtcNow.ToString('o');checkOnly=[bool]$Check;writes=0;installs=0;restarts=0;
 packages=$packages;profileSha256=$actualProfile;hostVersion=$hostVersion;oldPid=$OldPid;oldProcessExited=$true;
 newPid=$process.ProcessId;parentPid=$process.ParentProcessId;creationDate=$process.CreationDate;ports=$ports;
 autostartEnabled=$task.Settings.Enabled;taskState=[string]$task.State;authenticatedWeb=$web;sourceCount=$sources.total;
 health=@{status=$health.status;recoveryIssueCount=$health.recoveryIssueCount;inboundProcessing=$health.inboundProcessing;bridgeHealthy=$health.dwsBridge.healthy;listeners=$listeners;backfills=$backfills};
 maintenance='Retired workflow API; native lifecycle restores inbound/autostart, no legacy Resume';backupCreated=$false}|ConvertTo-Json -Depth 6
