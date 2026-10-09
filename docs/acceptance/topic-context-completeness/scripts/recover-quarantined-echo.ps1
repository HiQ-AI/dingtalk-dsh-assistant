param(
 [switch]$Check,[switch]$Resume,
 [ValidateSet('echo','notification','verification')][string]$Scope='echo',
 [string]$IncidentManifest,
 [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedProfileSha256,
 [Parameter(Mandatory)][string]$EvidenceDirectory,
 [ValidateRange(1,600)][int]$WaitSeconds=180
)
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$profile='D:/dsh_home/profiles/web/cordis.patch.yml'
$node='D:/soft/node-v24.19.0/node.exe'
$helper=Join-Path $PSScriptRoot 'recover-quarantined-echo.mjs'
$bootstrap=Join-Path $workspace 'scripts/bootstrap-workflow-maintenance.mjs'
$runId='msg-92023445605d174a87e6028d94c579a24ca3012f'
$initialRevision=30
if($Scope-in@('notification','verification')){
 if(-not[IO.Path]::IsPathFullyQualified($IncidentManifest)-or-not[IO.Path]::GetFullPath($IncidentManifest).StartsWith((Join-Path $workspace 'docs/tmp')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw '事故清单须为本工作树docs/tmp内绝对路径'}
 $incident=Get-Content -LiteralPath $IncidentManifest -Raw|ConvertFrom-Json
 $incidentHash=(Get-FileHash -LiteralPath $IncidentManifest).Hash
 $runId=$incident.runId;$initialRevision=[int]$incident.initialRevision
 $helper=Join-Path $PSScriptRoot $(if($Scope-eq'verification'){'recover-verification-drain.mjs'}else{'recover-notification-readback.mjs'})
}
function Helper([string]$Mode){
 if($Scope-in@('notification','verification')){
  if((Get-FileHash -LiteralPath $IncidentManifest).Hash-ne$incidentHash){throw '事故清单漂移'}
  return Node @($helper,$Mode,$IncidentManifest,$EvidenceDirectory)
 }
 return Node @($helper,$Mode,$EvidenceDirectory)
}
if(-not[IO.Path]::IsPathFullyQualified($EvidenceDirectory)-or-not[IO.Path]::GetFullPath($EvidenceDirectory).StartsWith((Join-Path $workspace 'docs/tmp')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw '证据目录必须在当前工作树 docs/tmp 下'}
function Node([string[]]$Arguments){$output=& $node @Arguments;if($LASTEXITCODE){throw '原生恢复工具失败；保持维护和fence，禁止启动/强停'};return (($output-join "`n")|ConvertFrom-Json)}
function Hash { (Get-FileHash -LiteralPath $profile).Hash.ToLowerInvariant() }
function State { Invoke-RestMethod http://127.0.0.1:18998/runtime/maintenance -NoProxy -TimeoutSec 15 }
function Assert-Initial($state){
 if($Scope-eq'verification'){
  if(-not$state.active-or$state.phase-ne'draining'-or$state.maintenanceId-ne$incident.maintenanceId-or$state.revision-ne$incident.maintenanceRevision-or$state.busy.nodes-ne1-or$state.busy.owners-or$state.busy.effects-or$state.busy.messages){throw '检查节点恢复的维护/排空身份变化'}
 }elseif($state.active-or$state.revision-ne$initialRevision-or$state.busy.messages-ne1){throw '事故初始状态已变化'}
}
function Instance {
 $ports=@(Get-NetTCPConnection -State Listen -LocalPort 3080 -ErrorAction Stop|Where-Object LocalAddress -eq '127.0.0.1')
 if($ports.Count-ne 1){throw 'Host 3080归属不唯一'}
 $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($ports[0].OwningProcess)"
 if($p.Name-ne 'node.exe'-or$p.ExecutablePath.Replace('\','/')-ne$node-or-not$p.CommandLine.Replace('\','/').Contains('D:/dsh_home/profiles/web/node_modules/')-or$p.CommandLine-notmatch 'dsh[\\/]lib[\\/]bin\.js.*web.*--no-open'){throw 'Host身份不匹配'}
 return $p
}
function Save { $record|ConvertTo-Json -Depth 20|Set-Content -LiteralPath "$EvidenceDirectory/recovery.tmp" -Encoding utf8;Move-Item -LiteralPath "$EvidenceDirectory/recovery.tmp" -Destination "$EvidenceDirectory/recovery.json" -Force }
function Assert-Host { $p=Instance;if($p.ProcessId-ne$record.pid-or$p.CreationDate.ToUniversalTime().ToString('o')-ne$record.processCreatedAt){throw 'Host发生替换，禁止接续'} }
function Wait-Witness([string]$kind){
 $deadline=(Get-Date).AddSeconds($WaitSeconds)
 do{Assert-Host;$file="$EvidenceDirectory/bootstrap-$kind.json";if(Test-Path -LiteralPath $file){$v=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json;if($v.kind-ne$kind-or$v.nonce-ne$record.nonce-or$v.pid-ne$record.pid-or$v.entryId-ne'dingtalk-dsh-assistant'-or$v.moduleName-ne'@zzusp/dingtalk-dsh-assistant/resident'){throw '完整退出见证身份无效'};return};Start-Sleep -Milliseconds 250}while((Get-Date)-lt$deadline)
 throw '等待完整退出见证超时；保持fence，不强停Host'
}
if($Check){
 if((Hash)-ne$ExpectedProfileSha256.ToLowerInvariant()){throw 'profile CAS不匹配'}
 $p=Instance;$native=Helper 'check';$state=State
 Assert-Initial $state
 Node @($bootstrap,'witness','--profile',$profile,'--expected-sha256',$ExpectedProfileSha256,'--evidence-directory',$EvidenceDirectory,'--expected-pid',[string]$p.ProcessId,'--nonce',([guid]::NewGuid().ToString()),'--check')|Out-Null
 @{status='CHECK_PASS';writes=0;runId=$runId;pid=$p.ProcessId;maintenanceRevision=$state.revision;repair=$native.check}|ConvertTo-Json -Depth 12
 return
}
if($Resume){
 $record=Get-Content -LiteralPath "$EvidenceDirectory/recovery.json" -Raw|ConvertFrom-Json -AsHashtable
 if($record.originalSha256-ne$ExpectedProfileSha256.ToLowerInvariant()-or$record.runId-ne$runId){throw '接续身份不匹配'}
 if($Scope-in@('notification','verification')-and($record.scope-ne$Scope-or$record.incidentHash-ne$incidentHash)){throw '事故接续清单不匹配'}
 Assert-Host
}else{
 if(Test-Path -LiteralPath $EvidenceDirectory){throw '证据目录必须全新，接续使用Resume'}
 if((Hash)-ne$ExpectedProfileSha256.ToLowerInvariant()){throw 'profile CAS不匹配'}
 $p=Instance;$preflight=Helper 'check';$state=State
 Assert-Initial $state
 New-Item -ItemType Directory -Path $EvidenceDirectory|Out-Null
 $record=@{runId=$runId;instanceId='dsh-web-runtime-v2-20260924';pid=[int]$p.ProcessId;processCreatedAt=$p.CreationDate.ToUniversalTime().ToString('o');nonce=[guid]::NewGuid().ToString();originalSha256=$ExpectedProfileSha256.ToLowerInvariant();maintenanceId='deploy-'+[guid]::NewGuid().ToString();maintenanceRevision=($initialRevision+1);scope=$Scope;incidentHash=$incidentHash;phase='prepared'}
 if($Scope-eq'verification'){$record.maintenanceId=$incident.maintenanceId;$record.maintenanceRevision=$incident.maintenanceRevision}
 Save
 $preflight|ConvertTo-Json -Depth 20|Set-Content "$EvidenceDirectory/preflight.json" -Encoding utf8
 if($Scope-ne'verification'){Copy-Item -LiteralPath $profile -Destination "$EvidenceDirectory/original-profile.yml"}
}
if($record.phase-eq'prepared'){
 $state=State
 if(-not$state.active){if($state.revision-ne$initialRevision){throw '维护水位变化'};$body=@{requestId=$record.maintenanceId;active=$true;expectedRevision=$initialRevision;maintenanceId=$record.maintenanceId;reason=if($Scope-eq'notification'){'独立核对已送达通知，停止派发'}else{'修复已确认自身回声遗留节点，停止派发'}}|ConvertTo-Json;$null=Invoke-RestMethod http://127.0.0.1:18998/runtime/maintenance -Method Post -ContentType 'application/json' -Headers @{Origin='http://127.0.0.1:3080'} -Body $body -NoProxy -TimeoutSec 20;$state=State}
 if(-not$state.active-or$state.phase-ne'draining'-or$state.maintenanceId-ne$record.maintenanceId-or$state.revision-ne$record.maintenanceRevision){throw '维护身份变化'}
 $record.phase='maintenance';Save
}
if($record.phase-eq'maintenance'){
 if(-not$record.witnessSha256){$planned=Node @($bootstrap,'witness','--profile',$profile,'--expected-sha256',$record.originalSha256,'--evidence-directory',$EvidenceDirectory,'--expected-pid',[string]$record.pid,'--nonce',$record.nonce,'--check');$record.witnessSha256=$planned.afterSha256;Save}
 if((Hash)-eq$record.originalSha256){Node @($bootstrap,'witness','--profile',$profile,'--expected-sha256',$record.originalSha256,'--evidence-directory',$EvidenceDirectory,'--expected-pid',[string]$record.pid,'--nonce',$record.nonce)|Out-Null}
 if((Hash)-ne$record.witnessSha256){throw 'witness配置CAS漂移'}
 Wait-Witness 'ready';$record.phase='witness';Save
}
if($record.phase-eq'witness'){
 if(-not$record.fencedSha256){$planned=Node @($bootstrap,'disable','--profile',$profile,'--expected-sha256',$record.witnessSha256,'--check');$record.fencedSha256=$planned.afterSha256;Save}
 if((Hash)-eq$record.witnessSha256){Node @($bootstrap,'disable','--profile',$profile,'--expected-sha256',$record.witnessSha256)|Out-Null}
 if((Hash)-ne$record.fencedSha256){throw 'fence配置CAS漂移'}
 Wait-Witness 'disposed';$record.phase='disposed';Save
}
if($record.phase-eq'disposed'){
 Assert-Host;Wait-Witness 'disposed'
 Helper 'repair'|Out-Null
 $record.phase='repaired';Save
}
if($record.phase-eq'repaired'){
 Assert-Host
 if((Hash)-eq$record.fencedSha256){Node @($bootstrap,'enable','--profile',$profile,'--expected-sha256',$record.fencedSha256)|Out-Null}
 if((Hash)-ne$record.originalSha256){throw '恢复profile不匹配'}
 $record.phase='enabled';Save
}
if($record.phase-ne'enabled'-and$record.phase-ne'complete'){throw '恢复阶段无效'}
$deadline=(Get-Date).AddSeconds($WaitSeconds)
do{
 Assert-Host
 try{$state=State}catch{Start-Sleep -Milliseconds 500;continue}
 if($state.active-and$state.phase-eq'draining'-and$state.drained-and$state.maintenanceId-eq$record.maintenanceId-and$state.revision-eq$record.maintenanceRevision){$record.phase='complete';Save;$state|ConvertTo-Json -Depth 12|Set-Content "$EvidenceDirectory/resident-readback.json" -Encoding utf8;@{status='RECOVERED';ContinueMaintenanceId=$record.maintenanceId;ExpectedMaintenanceRevision=$state.revision;profileSha256=(Hash);pid=$record.pid;drained=$state.drained}|ConvertTo-Json;return}
 throw 'Resident恢复后维护身份或排空结果不匹配'
}while((Get-Date)-lt$deadline)
throw 'Resident未恢复；维护保持，使用同证据Resume'
