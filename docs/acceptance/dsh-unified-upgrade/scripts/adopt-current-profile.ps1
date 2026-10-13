param(
 [switch]$Check,
 [switch]$Verify,
 [Parameter(Mandatory)][string]$OriginEvidenceDirectory,
 [Parameter(Mandatory)][string]$EvidenceDirectory,
 [Parameter(Mandatory)][string]$SemanticAudit,
 [Parameter(Mandatory)][string]$ExpectedPatchSha256,
 [Parameter(Mandatory)][int]$ExpectedPid
)
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..')).Replace('\','/').TrimEnd('/')
$profile='D:/dsh_home/profiles/web';$node='D:/soft/node-v24.19.0/node.exe'
$helper="$PSScriptRoot/apply-host-upgrade.mjs"
$presetValidator="$PSScriptRoot/verify-current-presets.mjs"
$presetProposal="$workspace/docs/tmp/host-upgrade-proposal.json"
function Hash([string]$path){(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Read-Json([string]$path){Get-Content -LiteralPath $path -Raw|ConvertFrom-Json -AsHashtable}
function Write-Json([string]$path,$value){[IO.File]::WriteAllText($path,($value|ConvertTo-Json -Depth 100),[Text.UTF8Encoding]::new($false))}
foreach($directory in @($OriginEvidenceDirectory,$EvidenceDirectory)){
 if(-not [IO.Path]::IsPathFullyQualified($directory) -or -not [IO.Path]::GetFullPath($directory).Replace('\','/').StartsWith("$workspace/docs/tmp/",[StringComparison]::OrdinalIgnoreCase)){throw '采用证据须在当前工作区docs/tmp绝对目录'}
}
if($Check -and $Verify){throw 'Check与Verify不可同时使用'}
if(-not $Verify -and (Test-Path -LiteralPath $EvidenceDirectory)){throw '新采用目录必须不存在'}
$originPath=Join-Path $OriginEvidenceDirectory 'launch.json'
$origin=Read-Json $originPath
foreach($path in $origin.inputPaths){if((Hash $path)-ne $origin.inputHashes[$path].ToLowerInvariant()){throw '原冻结输入漂移'}}
if($origin.hostUpgradeProposal -ne "$workspace/docs/tmp/host-dependency-repair-proposal.json" -or $origin.backupCreated -ne $false -or $origin.mode -ne 'maintenance'){throw '只允许当前统一升级记录采用'}
if((Hash $origin.deploymentControlPath)-ne $origin.deploymentControlSha256.ToLowerInvariant() -or (Hash "$OriginEvidenceDirectory/host-upgrade-applied.json")-ne $origin.hostUpgradeProofSha256.ToLowerInvariant()){throw '原控制或安装回执漂移'}
$audit=Read-Json $SemanticAudit
$auditHash=Hash $SemanticAudit
if($audit.kind-ne 'current-config-semantic-audit' -or $audit.opaqueJs-ne $true -or $audit.evaluatedExpressions-ne 0 -or $audit.originalRawPrefixRecovered-ne $false -or $audit.patchSha256-ne $ExpectedPatchSha256 -or @($audit.differences).Count){throw '当前配置语义审计不匹配'}
if((@($audit.frozenRows.id)-join ',')-ne 'compaction-basic,preset-standard,preset-ptc,preset-cordis' -or @($audit.frozenRows|Where-Object {$_.equal-ne $true -or $_.differences-ne 0}).Count){throw '四个升级节点必须完全匹配'}
function Assert-Current {
 if((Hash "$profile/cordis.patch.yml")-ne $ExpectedPatchSha256){throw '当前配置CAS漂移，禁止覆盖并行设置'}
 $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedPid"
 $ports=@(Get-NetTCPConnection -State Listen -LocalPort 3080,18998 -ErrorAction Stop)
 if(-not $proc -or $proc.Name-ne 'node.exe' -or $proc.ExecutablePath.Replace('\','/')-ne $node -or $proc.CommandLine.Replace('\','/')-notlike "*$profile/node_modules/*dsh/lib/bin.js*web*--no-open*" -or $ports.Count-ne 2 -or @($ports|Where-Object {$_.OwningProcess-ne $ExpectedPid -or $_.LocalAddress-ne '127.0.0.1'}).Count -or $proc.CreationDate.ToUniversalTime()-lt [datetime]$origin.startedAt){throw '同次正式新进程身份不匹配'}
 $maintenance=Invoke-RestMethod http://127.0.0.1:18998/runtime/maintenance -NoProxy -TimeoutSec 15
 $sealed=Read-Json "$OriginEvidenceDirectory/maintenance-sealed.json"
 if($maintenance.active-ne $true -or $maintenance.phase-ne 'stopping' -or $maintenance.maintenanceId-ne $origin.maintenanceId -or $maintenance.revision-ne $sealed.state.revision -or $maintenance.sealedIncarnation-ne $sealed.state.sealedIncarnation -or $maintenance.processIncarnation-notlike "${ExpectedPid}:*" -or $maintenance.resumePermitted-ne $true -or $maintenance.drained-ne $true -or @('nodes','owners','effects','messages'|Where-Object {$maintenance.busy.$_-ne 0}).Count){throw '当前维护许可或排空漂移'}
 if($identity -and ($identity.createdUtc-ne $proc.CreationDate.ToUniversalTime().ToString('o') -or $identity.processIncarnation-ne $maintenance.processIncarnation)){throw '采用过程中同PID实例身份漂移'}
 [pscustomobject]@{pid=$ExpectedPid;createdUtc=$proc.CreationDate.ToUniversalTime().ToString('o');processIncarnation=$maintenance.processIncarnation;maintenanceId=$maintenance.maintenanceId;revision=$maintenance.revision;patchSha256=$ExpectedPatchSha256}
}
$identity=Assert-Current
$presetText=& $node $presetValidator --snapshot "$profile/cordis.patch.yml" --proposal $presetProposal
if($LASTEXITCODE){throw '四个完整升级节点现场重新核验失败'}
$presetProof=$presetText|ConvertFrom-Json
if($presetProof.patchSha256-ne $ExpectedPatchSha256 -or $presetProof.writes-ne 0 -or $presetProof.evaluatedExpressions-ne 0 -or $presetProof.exact-ne $true){throw '现场预设复验摘要不匹配'}
$requiredEvidence=@($originPath,$origin.deploymentControlPath,"$OriginEvidenceDirectory/host-upgrade-applied.json","$OriginEvidenceDirectory/control-before.json","$OriginEvidenceDirectory/maintenance-sealed.json",$SemanticAudit,$PSCommandPath,$presetValidator,$presetProposal,"$workspace/docs/tmp/formal-config-semantic-audit.mjs","$workspace/docs/tmp/production-native-setup-receipt.json","$workspace/docs/tmp/production-ui-readback.json","$workspace/docs/tmp/production-ui-native-readback.mjs","$EvidenceDirectory/current-profile.yml","$EvidenceDirectory/semantic-audit.json","$EvidenceDirectory/host-upgrade-applied.json","$EvidenceDirectory/control-before.json","$EvidenceDirectory/maintenance-sealed.json")
$proofText=& $node $helper --verify --profile $profile --proposal $origin.hostUpgradeProposal
if($LASTEXITCODE){throw '冻结helper原生verify失败'}
$proof=$proofText|ConvertFrom-Json -AsHashtable
if($proof.mode-ne 'verify' -or $proof.writes-ne 0 -or $proof.patchSha256-ne $ExpectedPatchSha256 -or $proof.packageJsonSha256-ne (Read-Json "$OriginEvidenceDirectory/host-upgrade-applied.json").packageJsonSha256){throw '真实原生verify摘要不匹配'}
if($Verify){
 $receipt=Read-Json "$EvidenceDirectory/adoption.json"
 if($receipt.kind-ne 'adopt-concurrent-user-settings' -or $receipt.currentPatchSha256-ne $ExpectedPatchSha256 -or $receipt.identity.pid-ne $identity.pid -or $receipt.identity.createdUtc-ne $identity.createdUtc -or $receipt.identity.processIncarnation-ne $identity.processIncarnation -or $receipt.semanticAuditSha256-ne $auditHash -or $receipt.originalRawPrefixRecovered-ne $false -or $receipt.writerProven-ne $false -or $receipt.originalPrefixUnchangedClaimed-ne $false -or $receipt.productionWrites-ne 0 -or $receipt.newLaunch-ne $false -or $receipt.userReported-ne '另一个会话应该操作过' -or $receipt.beforePatchSha256-ne $origin.profileSha256 -or $receipt.readbackProofMode-ne 'verify'){throw '采用身份、审计或真实边界漂移'}
 foreach($path in $requiredEvidence){if(-not $receipt.frozenEvidence.ContainsKey($path)){throw '采用必需证据缺失'}}
 foreach($path in $receipt.frozenEvidence.Keys){if((Hash $path)-ne $receipt.frozenEvidence[$path]){throw '采用证据链漂移'}}
 if((Hash "$EvidenceDirectory/current-profile.yml")-ne $ExpectedPatchSha256 -or (Hash "$EvidenceDirectory/semantic-audit.json")-ne $auditHash -or (Read-Json "$EvidenceDirectory/semantic-audit.json").patchSha256-ne $ExpectedPatchSha256 -or (Read-Json "$EvidenceDirectory/host-upgrade-applied.json").patchSha256-ne $ExpectedPatchSha256){throw '私有快照、审计、真实verify须与当前配置互绑定'}
 $launch=Read-Json "$EvidenceDirectory/launch.json"
 foreach($path in $origin.inputPaths){if($path-notin $launch.inputPaths -or $launch.inputHashes[$path]-ne $origin.inputHashes[$path] -or $receipt.originalFrozenInputs[$path]-ne $origin.inputHashes[$path]){throw '原冻结输入未完整保留'}}
 foreach($path in $receipt.frozenEvidence.Keys){if($path-notin $launch.inputPaths -or $launch.inputHashes[$path].ToLowerInvariant()-ne $receipt.frozenEvidence[$path]){throw '采用回执与launch冻结链不一致'}}
 foreach($path in $launch.inputPaths){if((Hash $path)-ne $launch.inputHashes[$path].ToLowerInvariant()){throw '采用后冻结输入漂移'}}
 if($launch.startedAt-ne $origin.startedAt -or $launch.launchMethod-ne $origin.launchMethod -or $launch.launchTaskName-ne $origin.launchTaskName -or $launch.sourceProfileSha256-ne $origin.sourceProfileSha256 -or $launch.profileSha256-ne $ExpectedPatchSha256 -or $launch.repairOfLaunch-ne $originPath -or $launch.repairOfLaunchSha256-ne (Hash $originPath) -or $launch.adoptionPath-ne "$EvidenceDirectory/adoption.json" -or $launch.adoptionSha256-ne (Hash $launch.adoptionPath) -or $launch.hostUpgradeProofSha256-ne (Hash "$EvidenceDirectory/host-upgrade-applied.json") -or $launch.deploymentControlPath-ne "$EvidenceDirectory/deployment-control.json" -or $launch.deploymentControlSha256-ne (Hash $launch.deploymentControlPath)){throw '新launch未保留原启动链'}
 $control=Read-Json $launch.deploymentControlPath;$oldControl=Read-Json $origin.deploymentControlPath
 foreach($key in @('sourceProfileSha256','packageSha256','oldPid','backupCreated','backupScope','backup')){if($control[$key]-ne $oldControl[$key]){throw '新控制记录身份变更'}}
 if($control.repairOfControl-ne $origin.deploymentControlPath -or $control.repairOfControlSha256-ne (Hash $origin.deploymentControlPath)){throw '新控制记录未关联原控制记录'}
 foreach($path in $oldControl.originalEvidenceHashes.Keys){if($control.originalEvidenceHashes[$path]-ne $oldControl.originalEvidenceHashes[$path]){throw '原控制证据未完整保留'}}
 foreach($path in $receipt.frozenEvidence.Keys){if($control.originalEvidenceHashes[$path]-ne $receipt.frozenEvidence[$path]){throw '采用回执与控制冻结链不一致'}}
 foreach($path in $launch.inputPaths){if($control.inputHashes[$path]-ne $launch.inputHashes[$path]){throw '控制与launch输入不一致'}}
 if((Hash "$EvidenceDirectory/control-before.json")-ne (Hash "$OriginEvidenceDirectory/control-before.json") -or (Hash "$EvidenceDirectory/maintenance-sealed.json")-ne (Hash "$OriginEvidenceDirectory/maintenance-sealed.json") -or (($proof|ConvertTo-Json -Compress -Depth 100)-ne ((Read-Json "$EvidenceDirectory/host-upgrade-applied.json")|ConvertTo-Json -Compress -Depth 100))){throw '当前原生verify或控制副本不一致'}
 [void](Assert-Current)
 '采用Verify通过，当前配置/同次进程/维护/原冻结输入不变';exit
}
if($Check){[void](Assert-Current);[pscustomobject]@{check=$true;productionWrites=0;evidenceWrites=0;frozenInputs=$origin.inputPaths.Count;identity=$identity;originalRawPrefixRecovered=$false}|ConvertTo-Json -Depth 5;exit}
[void](Assert-Current)
[void](New-Item -ItemType Directory -Path $EvidenceDirectory)
Copy-Item -LiteralPath "$profile/cordis.patch.yml" -Destination "$EvidenceDirectory/current-profile.yml"
Copy-Item -LiteralPath $SemanticAudit -Destination "$EvidenceDirectory/semantic-audit.json"
if((Hash "$EvidenceDirectory/current-profile.yml")-ne $ExpectedPatchSha256 -or (Hash "$EvidenceDirectory/semantic-audit.json")-ne $auditHash -or (Read-Json "$EvidenceDirectory/semantic-audit.json").patchSha256-ne $ExpectedPatchSha256){throw '复制期间快照或审计漂移，保持维护不恢复'}
foreach($name in @('control-before.json','maintenance-sealed.json')){Copy-Item -LiteralPath "$OriginEvidenceDirectory/$name" -Destination "$EvidenceDirectory/$name"}
Write-Json "$EvidenceDirectory/host-upgrade-applied.json" $proof
$frozen=@{}
foreach($path in $requiredEvidence){$frozen[$path]=Hash $path}
$receipt=@{kind='adopt-concurrent-user-settings';adoptedAt=(Get-Date).ToUniversalTime().ToString('o');userReported='另一个会话应该操作过';writerProven=$false;originalRawPrefixRecovered=$false;originalPrefixUnchangedClaimed=$false;beforePatchSha256=$origin.profileSha256;currentPatchSha256=$ExpectedPatchSha256;semanticAuditSha256=Hash $SemanticAudit;identity=$identity;productionWrites=0;newLaunch=$false;frozenEvidence=$frozen;readbackProofMode='verify';originalFrozenInputs=$origin.inputHashes}
Write-Json "$EvidenceDirectory/adoption.json" $receipt
$launch=Read-Json $originPath
$launch.repairOfLaunch=$originPath;$launch.repairOfLaunchSha256=Hash $originPath
$launch.profileSha256=$ExpectedPatchSha256;$launch.hostUpgradeProofSha256=Hash "$EvidenceDirectory/host-upgrade-applied.json"
$launch.adoptionPath="$EvidenceDirectory/adoption.json";$launch.adoptionSha256=Hash $launch.adoptionPath
foreach($path in @($frozen.Keys)+@($launch.adoptionPath)){if($path-notin $launch.inputPaths){$launch.inputPaths+=@($path)};$launch.inputHashes[$path]=Hash $path}
$control=Read-Json $origin.deploymentControlPath
$control.repairOfControl=$origin.deploymentControlPath;$control.repairOfControlSha256=Hash $origin.deploymentControlPath
foreach($path in $frozen.Keys){$control.originalEvidenceHashes[$path]=$frozen[$path]}
$control.originalEvidenceHashes[$launch.adoptionPath]=$launch.adoptionSha256
$control.inputHashes=$launch.inputHashes
$launch.deploymentControlPath="$EvidenceDirectory/deployment-control.json"
Write-Json $launch.deploymentControlPath $control
$launch.deploymentControlSha256=Hash $launch.deploymentControlPath
Write-Json "$EvidenceDirectory/launch.json" $launch
[void](Assert-Current)
[pscustomobject]@{adopted=$true;productionWrites=0;restarted=$false;resumed=$false;pid=$ExpectedPid;evidenceDirectory=$EvidenceDirectory;patchSha256=$ExpectedPatchSha256}|ConvertTo-Json
