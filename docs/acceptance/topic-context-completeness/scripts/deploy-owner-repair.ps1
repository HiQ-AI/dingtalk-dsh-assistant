param(
  [switch]$Check,
  [switch]$Readback,
  [switch]$Resume,
  [switch]$Bootstrap,
  [switch]$HoldMaintenance,
  [switch]$MigrateMessageImpact,
  [string]$RepairStoppedLaunch,
  [string]$TaskDirectory,
  [string]$TaskMigrationPlan,
  [string]$EnrollmentProposal,
  [string]$ContinueMaintenanceId,
  [Nullable[int]]$ExpectedMaintenanceRevision,
  [ValidateRange(1,600)][int]$WaitSeconds=300,
  [Parameter(Mandatory)][string]$Package,
  [string]$Bundle,
  [string]$MergePolicy,
  [string]$ChecksProposal,
  [string]$DirectQueriesProposal,
  [string]$ObserverPackage,
  [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedObserverPackageSha256,
  [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedProfileSha256,
  [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedPackageSha256,
  [Parameter(Mandatory)][string]$EvidenceDirectory
)
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..')).Replace('\','/').TrimEnd('/')
$profile='D:/dsh_home/profiles/web'
$runtime='D:/dsh_home/workflows/runtime-v2'
$node='D:/soft/node-v24.19.0/node.exe'
$checker=Join-Path $PSScriptRoot 'check-repair-deployment.mjs'
$bootstrapTool="$workspace/scripts/bootstrap-workflow-maintenance.mjs"
$source="$workspace/packages/dingtalk-dsh-assistant"
$installed="$profile/node_modules/@zzusp/dingtalk-dsh-assistant"
$tempDirectory="$runtime/local-acceptance/temp"
$domain='D:/dsh_home/storages/dingtalk-dsh-assistant-v9-pr116'
$starter='D:/project/dingtalk-dsh-assistant/scripts/start-web.ps1'
$enrollmentTaskName='DSH Web Local'
function Assert-DeploymentMode {
 if($MigrateMessageImpact -and ($Bootstrap -or $RepairStoppedLaunch)){throw '来源影响迁移要求完整维护部署，不支持Bootstrap或离线修复入口'}
 if($RepairStoppedLaunch){
  if($TaskMigrationPlan){throw '离线修复不能新增任务文件迁移；须走完整备份部署'}
  if($ObserverPackage -and (Split-Path -Leaf $RepairStoppedLaunch)-ne 'maintenance-sealed.json'){throw '已launch离线修复不得改变Observer'}
  if([bool]$ObserverPackage-ne [bool]$ExpectedObserverPackageSha256){throw 'Observer包及摘要须同时提供'}
  if($Bundle -or $MergePolicy -or $ChecksProposal -or $Bootstrap -or $EnrollmentProposal -or $ContinueMaintenanceId -or $null-ne $ExpectedMaintenanceRevision){throw '离线修复只允许更换Assistant包，沿用原封存许可'}
  return
 }
 if($DirectQueriesProposal){
  if($Bundle -or $MergePolicy -or $ChecksProposal -or $Bootstrap){throw '查询配置模式与工程配置及Bootstrap互斥'}
 }elseif(-not $Bundle -or -not $MergePolicy -or -not $ChecksProposal){throw '工程模式需要Bundle、MergePolicy和ChecksProposal'}
 if([bool]$ObserverPackage-ne [bool]$ExpectedObserverPackageSha256){throw 'Observer包及摘要须同时提供'}
}
Assert-DeploymentMode
$observerSource="$workspace/packages/dingtalk-dsh-observer"
$observerInstalled="$profile/node_modules/@zzusp/dingtalk-dsh-observer"
$observerSourceReplacement=if($RepairStoppedLaunch -and (Split-Path -Leaf $RepairStoppedLaunch)-eq 'maintenance-sealed.json'){$ObserverPackage}else{''}
if($observerSourceReplacement){
 $candidateManifest=(& tar -xOf $ObserverPackage 'package/package.json' | Out-String | ConvertFrom-Json)
 $currentManifest=Get-Content -LiteralPath "$observerInstalled/package.json" -Raw|ConvertFrom-Json
 if($candidateManifest.name-ne '@zzusp/dingtalk-dsh-observer'){throw 'Observer修复包身份不匹配'}
 if($candidateManifest.version-eq $currentManifest.version){$observerSource=$observerInstalled}
}
function Assert-PersistentPackageSources([string]$Root,[string[]]$Paths) {
 $directory=Get-Item -LiteralPath $Root -ErrorAction Stop
 if(-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '持久包目录无效'}
 foreach($path in $Paths){
  $item=Get-Item -LiteralPath $path -ErrorAction Stop
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
     -not [string]::Equals((Split-Path -Parent $item.FullName),$directory.FullName,[StringComparison]::OrdinalIgnoreCase)){
   throw '部署包须直接存放在持久目录 D:/dsh_home/packages'
  }
 }
}
$deploymentInputs=@($Package)+@(@($Bundle,$MergePolicy,$ChecksProposal,$DirectQueriesProposal,$ObserverPackage,$TaskMigrationPlan)|Where-Object {$_})
if($EnrollmentProposal){$deploymentInputs+= $EnrollmentProposal}
if($TaskMigrationPlan){$deploymentInputs+="$workspace/scripts/migrate-task-file-links.mjs"}
if($MigrateMessageImpact){$deploymentInputs+=@($checker,"$workspace/scripts/migrate-message-impact.js")+@(Get-ChildItem -LiteralPath $source -Filter '*.js' -File|ForEach-Object FullName)}
$migrationToolSha256=if($TaskMigrationPlan){(Get-FileHash -LiteralPath "$workspace/scripts/migrate-task-file-links.mjs").Hash}else{''}
foreach($path in $deploymentInputs) {
 if(-not [IO.Path]::IsPathFullyQualified($path) -or -not(Test-Path -LiteralPath $path -PathType Leaf)){throw '输入文件须为存在的绝对路径'}
}
if(-not ($Readback -or $Resume)){Assert-PersistentPackageSources 'D:/dsh_home/packages' (@($Package)+@($ObserverPackage|Where-Object {$_}))}
if(-not [IO.Path]::IsPathFullyQualified($EvidenceDirectory) -or ((Test-Path -LiteralPath $EvidenceDirectory) -and -not ($Readback -or $Resume))){throw '证据目录须为新的绝对路径'}
if(-not $EvidenceDirectory.Replace('\','/').StartsWith("$workspace/docs/tmp/",[StringComparison]::OrdinalIgnoreCase)){throw '证据目录必须在本工作区docs/tmp内'}
if(-not(Test-Path -LiteralPath $tempDirectory -PathType Container)){throw 'D盘TEMP目录不存在'}
function Run-Node([string[]]$Arguments){
 $result=& $node @Arguments
 if($LASTEXITCODE){throw 'Node命令失败，停止部署'}
 return ($result -join "`n")
}
# 显式指定 Agent 工作区的 tasks 目录；检查仅只读，存在任务引用时缺参即拒绝。
$taskDirectoryProof=Run-Node @($checker,'task-directory-check',$TaskDirectory)|ConvertFrom-Json
if($taskDirectoryProof.taskDirectory){$TaskDirectory=$taskDirectoryProof.taskDirectory}
function Wait-DrainedSnapshot {
 $deadline=(Get-Date).AddSeconds(60)
 do {
  $output=& $node $checker snapshot 2>&1
  $code=$LASTEXITCODE
  $text=($output|ForEach-Object {"$_"}) -join "`n"
  if($code-eq 0){return $text}
  if($text -notmatch '^DEPLOY_NOT_DRAINED:nodes=\d+,owners=\d+,effects=\d+,messages=\d+\s*$'){throw "控制快照检查失败：$text"}
  if((Get-Date)-ge $deadline){throw 'DEPLOY_NOT_DRAINED：60秒内未排空，未执行部署'}
  Start-Sleep -Milliseconds 1000
 }while((Get-Date)-lt $deadline)
 throw 'DEPLOY_NOT_DRAINED：60秒内未排空，未执行部署'
}
function Listeners { @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -in 3080,18998) }
function Instance {
 $listeners=@(Listeners)
 if(-not $listeners.Count){return $null}
 $ids=@($listeners.OwningProcess|Sort-Object -Unique)
 if($listeners.Count-ne 2 -or $ids.Count-ne 1 -or @($listeners|Where-Object LocalAddress -ne '127.0.0.1').Count){throw '双端口归属异常'}
 $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$($ids[0])"
 if($proc.Name-ne 'node.exe' -or $proc.ExecutablePath.Replace('\','/')-ne $node -or
   $proc.CommandLine-notmatch 'dsh[\\/]lib[\\/]bin\.js.*web.*--no-open' -or
   -not $proc.CommandLine.Replace('\','/').Contains("$profile/node_modules/")){throw '实例进程身份不匹配'}
 return $proc
}
function Same-Hash([string]$Left,[string]$Right){if((Get-FileHash -LiteralPath $Left).Hash-ne(Get-FileHash -LiteralPath $Right).Hash){throw '文件哈希不一致'}}
function Read-EnrollmentProposal {
 $value=Get-Content -LiteralPath $EnrollmentProposal -Raw|ConvertFrom-Json
 $keys=@($value.PSObject.Properties.Name|Sort-Object)
 if(($keys-join ',')-ne 'groupId,name,responsibility' -or
    @(@($value.groupId,$value.name,$value.responsibility)|Where-Object {$_ -isnot [string] -or -not $_.Trim()}).Count){throw '新群提案必须且仅包含非空 groupId/name/responsibility'}
 return $value
}
function Ensure-EnrollmentSubscription($proposal) {
 $groups=Invoke-RestMethod http://127.0.0.1:18998/state/groups -NoProxy -TimeoutSec 20
 $current=@($groups|Where-Object groupId -eq $proposal.groupId)
 if($current.Count-gt 1){throw '新群订阅不唯一'}
 if($current.Count){
  if($current[0].name-ne $proposal.name -or $current[0].responsibility-ne $proposal.responsibility -or $current[0].messages.Count -or $current[0].outbox.Count){throw '新群订阅已变化或非空'}
  return
 }
 $body=$proposal|ConvertTo-Json -Compress
 $null=Invoke-RestMethod http://127.0.0.1:18998/config/groups -Method Post -ContentType 'application/json' -Headers @{Origin='http://127.0.0.1:3080'} -Body $body -NoProxy -TimeoutSec 20
 $groups=Invoke-RestMethod http://127.0.0.1:18998/state/groups -NoProxy -TimeoutSec 20
 $verified=@($groups|Where-Object groupId -eq $proposal.groupId)
 if($verified.Count-ne 1 -or $verified[0].name-ne $proposal.name -or $verified[0].responsibility-ne $proposal.responsibility -or $verified[0].messages.Count -or $verified[0].outbox.Count){throw '新群原生订阅回读不一致'}
}
function Restore-EnrollmentAutostart($record) {
 if($record.enrollmentAutostartRestore){
  $task=@(Get-ScheduledTask -TaskName $enrollmentTaskName -ErrorAction Stop)
  if($task.Count-ne 1){throw '接入后自启任务身份不唯一'}
  if([string]$task[0].State-eq 'Disabled'){$null=Enable-ScheduledTask -TaskName $enrollmentTaskName}
  if([string](Get-ScheduledTask -TaskName $enrollmentTaskName).State-eq 'Disabled'){throw '接入后自启任务未恢复'}
 }
}
function Acquire-OwnerLock {
 $deadline=(Get-Date).AddSeconds($WaitSeconds)
 do {
 $info=[Diagnostics.ProcessStartInfo]::new($node)
 $info.UseShellExecute=$false;$info.CreateNoWindow=$true
 $info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
 $info.ArgumentList.Add($checker);$info.ArgumentList.Add('lock')
 $process=[Diagnostics.Process]::Start($info)
 if($process.StandardOutput.ReadLine()-ne 'LOCKED'){
  $failure=$process.StandardError.ReadToEnd();$process.StandardInput.Close();$process.WaitForExit();$process.Dispose()
  if(-not $Bootstrap -or $failure.Trim()-ne 'database is locked' -or (Get-Date)-ge $deadline){throw '无法取得离线实例独占锁'}
  Start-Sleep -Milliseconds 250
  continue
 }
 return $process
 }while((Get-Date)-lt $deadline)
 throw '无法取得离线实例独占锁'
}
function Wait-BootstrapResidentClosed($old) {
 $deadline=(Get-Date).AddSeconds($WaitSeconds)
 do {
  $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($old.ProcessId)"
  if(-not $current -or $current.CreationDate-ne $old.CreationDate){throw '首次切换旧进程身份漂移'}
  $ports=@(Listeners)
  if(@($ports|Where-Object {$_.LocalPort-eq 3080 -and $_.OwningProcess-eq $old.ProcessId -and $_.LocalAddress-eq '127.0.0.1'}).Count-ne 1){throw '首次切换3080归属漂移'}
  if(-not @($ports|Where-Object LocalPort -eq 18998).Count){return}
  Start-Sleep -Milliseconds 500
 }while((Get-Date)-lt $deadline)
 throw 'Resident未完成退出；保持禁用，不停止进程'
}
function Wait-BootstrapWitness([string]$kind,$old,[string]$nonce) {
 $file=Join-Path $EvidenceDirectory "bootstrap-$kind.json"
 $deadline=(Get-Date).AddSeconds($WaitSeconds)
 do {
  if(Test-Path -LiteralPath $file){
   $proof=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json
   if($proof.kind-ne $kind -or $proof.nonce-ne $nonce -or $proof.pid-ne $old.ProcessId -or $proof.entryId-ne 'dingtalk-dsh-assistant' -or $proof.moduleName-ne '@zzusp/dingtalk-dsh-assistant/resident'){throw 'Bootstrap完整退出见证身份错误'}
   return $proof
  }
  Start-Sleep -Milliseconds 250
 }while((Get-Date)-lt $deadline)
 throw 'Bootstrap完整退出见证未就绪；禁止停止旧进程'
}
function Assert-InputHashes {
 if($ObserverPackage -and (Get-FileHash -LiteralPath $ObserverPackage).Hash-ne $ExpectedObserverPackageSha256){throw 'Observer部署包摘要不匹配'}
 if((Get-FileHash -LiteralPath $Package).Hash.ToLowerInvariant()-ne $ExpectedPackageSha256.ToLowerInvariant()){throw 'package SHA不匹配'}
 if((Get-FileHash -LiteralPath "$profile/cordis.patch.yml").Hash.ToLowerInvariant()-ne $ExpectedProfileSha256.ToLowerInvariant()){throw 'profile CAS不匹配'}
}
function Invoke-MessageImpactMigration {
 if(-not $MigrateMessageImpact){return}
 if(-not $lockProcess -or $lockProcess.HasExited -or @(Listeners).Count){throw '来源影响迁移要求停机且持续持有owner独占锁'}
 foreach($path in $inputHashes.Keys){if((Get-FileHash -LiteralPath $path).Hash-ne $inputHashes[$path]){throw '迁移输入摘要漂移'}}
 $lockProcess.StandardInput.WriteLine('migrate-message-impact')
 $lockProcess.StandardInput.Flush()
 $line=$lockProcess.StandardOutput.ReadLine()
 if(-not $line){throw '来源影响迁移未返回证明，保持停机'}
 $proof=$line|ConvertFrom-Json
 if(-not $proof.verified -or $proof.version-ne 6 -or $lockProcess.HasExited){throw '来源影响迁移证明无效，禁止启动'}
 $proof|ConvertTo-Json -Depth 100|Set-Content "$EvidenceDirectory/message-impact-migration.json"
 return (Get-FileHash -LiteralPath "$EvidenceDirectory/message-impact-migration.json").Hash
}
function Assert-MessageImpactReadback($record) {
 if([bool]$MigrateMessageImpact-ne [bool]$record.messageImpactMigrationSha256){throw '来源影响迁移模式漂移'}
 if(-not $MigrateMessageImpact){return}
 $receipt="$EvidenceDirectory/message-impact-migration.json"
 if(-not(Test-Path -LiteralPath $receipt -PathType Leaf) -or (Get-FileHash -LiteralPath $receipt).Hash-ne $record.messageImpactMigrationSha256){throw '来源影响迁移证明摘要漂移'}
 return (Run-Node @($checker,'message-impact-verify',$receipt)|ConvertFrom-Json)
}
function Invoke-TaskFileMigration([string]$Mode,[string]$ExpectedJournalSha256='',[string]$BackupRoot=$backup,[string]$ExpectedBackupSha256='') {
 if(-not $TaskMigrationPlan){return}
 $tool="$workspace/scripts/migrate-task-file-links.mjs"
 $journal="$EvidenceDirectory/task-file-migration.json"
 if((Get-FileHash -LiteralPath $tool).Hash-ne $migrationToolSha256){throw '任务迁移工具摘要漂移'}
 if($Mode-ne 'check' -and $inputHashes -and $inputHashes.ContainsKey($tool) -and $inputHashes[$tool]-ne $migrationToolSha256){throw '任务迁移工具冻结摘要不一致'}
 if($Mode-eq 'check'){return Run-Node @($tool,'--check',$TaskMigrationPlan)}
 if($Mode-eq 'execute'){
  if(-not $lockProcess -or $lockProcess.HasExited -or @(Listeners).Count){throw '任务文件迁移要求停机且持有owner独占锁'}
  if((Get-FileHash -LiteralPath $TaskMigrationPlan).Hash-ne $inputHashes[$TaskMigrationPlan]){throw '任务迁移计划摘要漂移'}
  if(-not $BackupRoot){throw '任务迁移源备份目录缺失'}
  Run-Node @($tool,'--backup',$TaskMigrationPlan,"${BackupRoot}-task-migration-source")|Set-Content "$EvidenceDirectory/task-file-migration-backup.json"
  Run-Node @($tool,'--verify-backup',"${BackupRoot}-task-migration-source/backup-manifest.json")|Set-Content "$EvidenceDirectory/task-file-migration-backup-verified.json"
  Run-Node @($tool,'--execute',$TaskMigrationPlan,$journal)|Set-Content "$EvidenceDirectory/task-file-migration-execute.json"
 }elseif($Mode-ne 'verify'){throw '任务文件迁移模式无效'}
 if($Mode-eq 'verify'){
  if(-not $BackupRoot -or -not(Test-Path -LiteralPath "${BackupRoot}-task-migration-source/backup-manifest.json" -PathType Leaf)){throw '任务迁移源备份清单缺失'}
  if(-not $ExpectedBackupSha256 -or (Get-FileHash -LiteralPath "${BackupRoot}-task-migration-source/backup-manifest.json").Hash-ne $ExpectedBackupSha256){throw '任务迁移源备份清单摘要漂移'}
  [void](Run-Node @($tool,'--verify-backup',"${BackupRoot}-task-migration-source/backup-manifest.json"))
 }
 if(-not(Test-Path -LiteralPath $journal -PathType Leaf)){throw '任务文件迁移journal缺失'}
 if($ExpectedJournalSha256 -and (Get-FileHash -LiteralPath $journal).Hash-ne $ExpectedJournalSha256){throw '任务文件迁移journal摘要漂移'}
 $proof=Run-Node @($tool,'--verify',$journal)
 if($Mode-eq 'execute'){$proof|Set-Content "$EvidenceDirectory/task-file-migration-verified.json"}
 return $proof
}
function Change-Maintenance($state,[bool]$active,[string]$maintenanceId) {
 $body=@{requestId=[guid]::NewGuid().ToString();active=$active;expectedRevision=$state.revision;maintenanceId=$maintenanceId;reason=if($active){'受控本地部署，停止新派发'}else{'部署回读通过，恢复派发'}}|ConvertTo-Json
 return Invoke-RestMethod -Uri http://127.0.0.1:18998/runtime/maintenance -Method Post -ContentType 'application/json' -Headers @{Origin='http://127.0.0.1:3080'} -Body $body -NoProxy -TimeoutSec 20
}
function Assert-MaintenanceContinuation($state,$old) {
 if(-not $ContinueMaintenanceId -or $null-eq $ExpectedMaintenanceRevision -or
    -not $state.active -or $state.phase-ne 'draining' -or -not $state.drained -or
    $state.maintenanceId-ne $ContinueMaintenanceId -or $state.revision-ne $ExpectedMaintenanceRevision -or
    $state.processIncarnation-notmatch ('^'+[regex]::Escape([string]$old.ProcessId)+':')){throw '接续维护许可身份、版本或排空状态不匹配'}
}
function Change-MaintenancePhase($state,[string]$operation,[string]$maintenanceId) {
 if($operation -notin @('seal','resume')){throw '维护操作无效'}
 $body=@{requestId=[guid]::NewGuid().ToString();expectedRevision=$state.revision;maintenanceId=$maintenanceId;reason=if($operation-eq 'seal'){'排空完成，封存停机许可'}else{'新实例部署回读通过，恢复派发'}}|ConvertTo-Json
 return Invoke-RestMethod -Uri "http://127.0.0.1:18998/runtime/maintenance/$operation" -Method Post -ContentType 'application/json' -Headers @{Origin='http://127.0.0.1:3080'} -Body $body -NoProxy -TimeoutSec 20
}
function Assert-LaunchInputs($launchRecord) {
 if([string]$TaskMigrationPlan-ne [string]$launchRecord.taskMigrationPlan){throw '接续任务迁移计划漂移'}
 if($ExpectedPackageSha256-ne $launchRecord.packageSha256 -or $ExpectedProfileSha256-ne $launchRecord.sourceProfileSha256){throw '接续参数与原部署输入不一致'}
 if((Get-FileHash -LiteralPath $Package).Hash-ne $launchRecord.packageSha256){throw '接续部署包摘要不匹配'}
 if([string]$ObserverPackage-ne [string]$launchRecord.observerPackage -or [string]$ExpectedObserverPackageSha256-ne [string]$launchRecord.observerPackageSha256 -or [string]$DirectQueriesProposal-ne [string]$launchRecord.directQueriesProposal){throw '接续部署模式或Observer身份漂移'}
 foreach($path in $deploymentInputs){
  if($path-notin $launchRecord.inputPaths -or (Get-FileHash -LiteralPath $path).Hash-ne $launchRecord.inputHashes.$path){throw '接续配置输入漂移'}
 }
}
function Resume-Deployment($result,$launchRecord) {
 if(-not $result.ready){return $result}
 [void](Assert-MessageImpactReadback $launchRecord)
 $state=Invoke-RestMethod http://127.0.0.1:18998/runtime/maintenance -NoProxy -TimeoutSec 20
 if($state.maintenanceId-ne $launchRecord.maintenanceId){throw '维护许可身份不匹配'}
 if($state.active){
  if(-not $state.resumePermitted){throw '当前实例不具备封存许可恢复资格'}
  [void](Change-MaintenancePhase $state 'resume' $launchRecord.maintenanceId)
 }
 $after=Invoke-RestMethod http://127.0.0.1:18998/runtime/maintenance -NoProxy -TimeoutSec 20
 if($after.active -or $after.maintenanceId-ne $launchRecord.maintenanceId){throw '恢复派发回读失败'}
 $result.maintenance=$after;$result.dispatchResumed=$true
 Restore-EnrollmentAutostart $launchRecord
 return $result
}
function Read-Deployment($launchRecord) {
 $messageImpactProof=Assert-MessageImpactReadback $launchRecord
 if($TaskMigrationPlan){
  if($launchRecord.taskMigrationBackupManifest-ne "$($launchRecord.backup)-task-migration-source/backup-manifest.json"){throw '任务迁移源备份清单路径漂移'}
  [void](Invoke-TaskFileMigration 'verify' $launchRecord.taskMigrationJournalSha256 $launchRecord.backup $launchRecord.taskMigrationBackupSha256)
 }
 $deadline=(Get-Date).AddSeconds($WaitSeconds);$fresh=$null
 do {
  if(@(Listeners).Count-eq 2){
   $candidate=Instance
   if($candidate.CreationDate.ToUniversalTime()-lt ([datetime]$launchRecord.startedAt).ToUniversalTime() -or $candidate.ParentProcessId-ne $launchRecord.launcherPid){throw '监听进程并非此次启动实例'}
   $fresh=$candidate;break
  }
  Start-Sleep -Milliseconds 1000
 }while((Get-Date)-lt $deadline)
 $logs=@('start.stdout.log','start.stderr.log')|ForEach-Object {
  $file=Join-Path $EvidenceDirectory $_
  if(Test-Path -LiteralPath $file){
   # 活动日志仅记录元信息；写进程可独占内容句柄，暂态哈希不作为部署门禁。
   $metadata=Get-Item -LiteralPath $file
   @{name=$_;bytes=$metadata.Length;lastWriteTimeUtc=$metadata.LastWriteTimeUtc.ToString('o');live=$true}
  }
 }
 if(-not $fresh){return @{status='pending';ready=$false;restartAttempted=$false;launcherPid=$launchRecord.launcherPid;logs=@($logs);nextAction='使用相同参数附加 -Readback 继续零写回读，不重复部署或重启'}}
 if((Get-FileHash -LiteralPath $Package).Hash-ne $launchRecord.packageSha256 -or (Get-FileHash -LiteralPath "$profile/cordis.patch.yml").Hash-ne $launchRecord.profileSha256){throw '启动后包或profile漂移'}
 try {
  $tasks=Invoke-RestMethod http://127.0.0.1:18998/state/tasks -NoProxy -TimeoutSec 20
  $catalog=Invoke-RestMethod http://127.0.0.1:18998/state/workflows/catalog -NoProxy -TimeoutSec 20
 } catch { return @{status='pending';ready=$false;pid=$fresh.ProcessId;launcherPid=$launchRecord.launcherPid;logs=@($logs);restartAttempted=$false;nextAction='端口已监听，HTTP回读尚未完成；使用 -Readback 继续核对'} }
 $snapshot=Get-Content -LiteralPath "$EvidenceDirectory/control-before.json" -Raw|ConvertFrom-Json
 $ids=@($tasks|ForEach-Object taskId)
 foreach($id in $snapshot.tasks){
  if($ids -contains $id){continue}
  # 看板按逻辑任务合并；原物理身份必须仍可通过详情别名读取当前完整任务。
  $detail=Invoke-RestMethod "http://127.0.0.1:18998/state/tasks/$([uri]::EscapeDataString($id))/detail" -NoProxy -TimeoutSec 20
  if($detail.requestedTaskId-ne $id -or -not $detail.logicalTaskId -or $detail.taskId-ne $detail.latestTaskId -or $detail.taskId-notin $ids){throw '在线Task身份缺失'}
 }
 $history=Run-Node @($checker,'verify',"$EvidenceDirectory/control-before.json")|ConvertFrom-Json
 $packageReadback=Run-Node @($checker,'package',$Package,$source,$installed)|ConvertFrom-Json
 $observerReadback=if($ObserverPackage){Run-Node @($checker,'package',$ObserverPackage,$observerSource,$observerInstalled)|ConvertFrom-Json}else{$null}
 $webProof=Run-Node @($checker,'web',"$EvidenceDirectory/start.stdout.log")|ConvertFrom-Json
 $maintenance=Invoke-RestMethod http://127.0.0.1:18998/runtime/maintenance -NoProxy -TimeoutSec 20
 if($maintenance.maintenanceId-ne $launchRecord.maintenanceId){throw '启动后维护许可漂移'}
 return @{status='ready';ready=$true;pid=$fresh.ProcessId;launcherPid=$launchRecord.launcherPid;tasks=$tasks.Count;history=$history;messageImpact=$messageImpactProof;package=$packageReadback;observer=$observerReadback;web=$webProof;maintenance=$maintenance;dispatchResumed=(-not $maintenance.active);logs=@($logs);scheduledTaskChanged=[bool]$launchRecord.enrollmentAutostartRestore;businessAcceptancePassed=$false}
}
function Assert-LocalPackageSources([string]$ProfileRoot,[string]$AssistantReplacement='', [string]$ObserverReplacement='') {
 $code=@'
const fs=require('node:fs'),path=require('node:path'),{fileURLToPath}=require('node:url'),{createRequire}=require('node:module');
try {
 const [root,workspace,assistantReplacement,observerReplacement]=process.argv.slice(1),entries=[];
 const add=(name,spec)=>{if(typeof spec==='string'&&spec.startsWith('file:'))entries.push({name,spec})};
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 for(const section of ['dependencies','devDependencies','optionalDependencies'])for(const [name,spec]of Object.entries(manifest[section]||{}))add(name,spec);
 const pnpm=path.join(root,'pnpm-lock.yaml');
 if(fs.existsSync(pnpm)){
  const yaml=createRequire(path.join(workspace,'package.json'))('js-yaml'),lock=yaml.load(fs.readFileSync(pnpm,'utf8'));
  for(const importer of Object.values(lock.importers||{}))for(const section of ['dependencies','devDependencies','optionalDependencies'])for(const [name,value]of Object.entries(importer[section]||{}))add(name,value.specifier);
  for(const [key,value]of Object.entries(lock.packages||{}))add(key.split('@file:')[0],value.resolution?.tarball);
 }else{
  const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
  for(const [key,value]of Object.entries(lock.packages||{}))add(key.replace(/^node_modules\//,''),value.resolved);
  for(const [name,value]of Object.entries(lock.dependencies||{}))add(name,value.resolved);
 }
 for(const {name,spec}of entries){
  const replacement=name==='@zzusp/dingtalk-dsh-assistant'?assistantReplacement:name==='@zzusp/dingtalk-dsh-observer'?observerReplacement:'';
  const value=replacement?'file:'+replacement:spec;
  const target=value.startsWith('file://')?fileURLToPath(value):path.resolve(root,decodeURIComponent(value.slice(5)));
  if(!fs.existsSync(target)||!fs.statSync(target).isFile())throw Error('profile本地依赖源不存在: '+target);
 }
}catch(error){console.log(error.message);process.exitCode=1}
'@
 $result=& $node -e $code $ProfileRoot $workspace $AssistantReplacement $ObserverReplacement
 if($LASTEXITCODE){throw ($result -join "`n")}
}
function Read-StoppedRepairRecord([string]$Path,$sealed,$backupRecord) {
 if((Split-Path -Leaf $Path)-eq 'launch.json'){return Get-Content -LiteralPath $Path -Raw|ConvertFrom-Json}
 if((Split-Path -Leaf $Path)-ne 'maintenance-sealed.json'){throw '离线检查点必须为launch.json或maintenance-sealed.json'}
 $origin=Split-Path -Parent $Path
 foreach($name in @('launch.json','config-applied.json','enrollment-autostart.json','task-file-migration-execute.json','task-file-migration.json','task-file-migration-backup.json','message-impact-check.json','message-impact-migration.json')){
  if(Test-Path -LiteralPath "$origin/$name"){throw '封存安装检查点已进入其他部署阶段'}
 }
 if($DirectQueriesProposal -or $backupRecord.taskMigrationBackupManifest -or $backupRecord.taskMigrationBackupSha256){throw '封存安装续接不允许配置提案或任务迁移'}
 if(-not [IO.Path]::IsPathFullyQualified($backupRecord.backup) -or $backupRecord.packageSha256-ne $ExpectedPackageSha256){throw '封存安装仅可重试原备份绑定的包'}
 $originalProfileHash=(Get-FileHash -LiteralPath "$($backupRecord.backup)/profile/cordis.patch.yml").Hash
 if($originalProfileHash-ne $ExpectedProfileSha256){throw '原备份profile摘要不匹配'}
 return [pscustomobject]@{checkpoint='sealed-before-launch';mode='maintenance';backup=$backupRecord.backup;
  packageSha256=$backupRecord.packageSha256;sourceProfileSha256=$originalProfileHash;profileSha256=$originalProfileHash;
  maintenanceId=$sealed.state.maintenanceId;directQueriesProposal='';inputPaths=@();inputHashes=@{};launcherPid=$null}
}
function Assert-StoppedRepairPermit($record,$sealed,$before,$backupRecord,$current) {
 if($record.messageImpactMigrationSha256 -or $record.mode-ne 'maintenance' -or $record.enrollmentAutostartRestore -or ($record.observerPackage -and $record.checkpoint-ne 'sealed-before-launch') -or
    $record.sourceProfileSha256-ne $ExpectedProfileSha256 -or $record.profileSha256-ne $ExpectedProfileSha256 -or
    $backupRecord.backup-ne $record.backup -or $backupRecord.packageSha256-ne $record.packageSha256 -or
    ($record.checkpoint-ne 'sealed-before-launch' -and $record.packageSha256-eq $ExpectedPackageSha256) -or ([string]$record.directQueriesProposal).Replace('\','/')-ne ([string]$DirectQueriesProposal).Replace('\','/')){throw '原部署记录不允许本次离线修复'}
 foreach($state in @($sealed.state,$before.maintenance,$current)){
  if(-not $state.active -or $state.phase-ne 'stopping' -or -not $state.drained -or
     $state.maintenanceId-ne $record.maintenanceId -or $state.revision-ne $sealed.state.revision -or
     $state.sealedIncarnation-ne $sealed.state.sealedIncarnation -or
     -not $state.sealedIncarnation.StartsWith("$($backupRecord.oldPid):") -or
     @($state.busy.PSObject.Properties|Where-Object Value -ne 0).Count){throw '原维护封存许可已变化'}
 }
 if(-not $sealed.state.stopPermitted){throw '原部署缺少停止许可'}
}
function Assert-StoppedRepairProcesses($record,$backupRecord) {
 if(@(Listeners).Count){throw '离线修复要求双端口均无监听'}
 $live=@(Get-CimInstance Win32_Process|Where-Object {
  $_.ProcessId-eq $backupRecord.oldPid -or ($record.launcherPid -and ($_.ProcessId-eq $record.launcherPid -or $_.ParentProcessId-eq $record.launcherPid)) -or
  ($_.Name-eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Replace('\','/').Contains("$profile/node_modules/@deepseek-ai/dsh/"))
 })
 if($live.Count){throw '原进程、launcher或profile进程仍存在'}
}
if($Readback -or $Resume){
 if($Check -or ($Readback -and $Resume)){throw 'Readback、Resume和Check不可同时使用'}
 $launchRecord=Get-Content -LiteralPath "$EvidenceDirectory/launch.json" -Raw|ConvertFrom-Json
 Assert-LaunchInputs $launchRecord
 $result=Read-Deployment $launchRecord
 if($Resume){$result=Resume-Deployment $result $launchRecord}
 $result|ConvertTo-Json -Depth 10
 exit 0
}
Assert-InputHashes
Assert-LocalPackageSources $profile $Package $observerSourceReplacement
if($TaskMigrationPlan){$taskMigrationCheck=Invoke-TaskFileMigration 'check'|ConvertFrom-Json}
if($RepairStoppedLaunch){
 if(-not [IO.Path]::IsPathFullyQualified($RepairStoppedLaunch)){throw '原launch必须为绝对路径'}
 $origin=Split-Path -Parent $RepairStoppedLaunch
 $sealed=Get-Content -LiteralPath "$origin/maintenance-sealed.json" -Raw|ConvertFrom-Json
 $before=Get-Content -LiteralPath "$origin/control-before.json" -Raw|ConvertFrom-Json
 $backupRecord=Get-Content -LiteralPath "$origin/backup.json" -Raw|ConvertFrom-Json
 $record=Read-StoppedRepairRecord $RepairStoppedLaunch $sealed $backupRecord
 $evidenceHashes=@{}
 foreach($path in @($RepairStoppedLaunch,"$origin/maintenance-sealed.json","$origin/control-before.json","$origin/backup.json","$($record.backup)/manifest.json")+$deploymentInputs){$evidenceHashes[$path]=(Get-FileHash -LiteralPath $path).Hash}
 if($record.inputPaths-contains $Package){throw '修复包必须使用新的唯一路径'}
 if($DirectQueriesProposal -and (Get-FileHash -LiteralPath $DirectQueriesProposal).Hash-ne $record.inputHashes.($record.directQueriesProposal)){throw '原查询配置提案已变化'}
 function Test-StoppedRepair {
  Assert-InputHashes
  Assert-LocalPackageSources $profile $Package $observerSourceReplacement
  foreach($path in $evidenceHashes.Keys){if((Get-FileHash -LiteralPath $path).Hash-ne $evidenceHashes[$path]){throw '修复输入或原证据已变化'}}
  Assert-StoppedRepairProcesses $record $backupRecord
  $current=Run-Node @($checker,'maintenance')|ConvertFrom-Json
  Assert-StoppedRepairPermit $record $sealed $before $backupRecord $current
  $history=Run-Node @($checker,'verify',"$origin/control-before.json")|ConvertFrom-Json
  $backupProof=Run-Node @($checker,'backup-reverify',$record.backup,$TaskDirectory)|ConvertFrom-Json
  $packageProof=Run-Node @($checker,'package',$Package,$source)|ConvertFrom-Json
  $observerProof=$null
  if($ObserverPackage){
   $originalDependencies=Get-Content -LiteralPath "$($record.backup)/profile/package.json" -Raw|ConvertFrom-Json
   $currentObserver=Get-Content -LiteralPath "$observerInstalled/package.json" -Raw|ConvertFrom-Json
   if(-not $originalDependencies.dependencies.'@zzusp/dingtalk-dsh-observer' -or $currentObserver.name-ne '@zzusp/dingtalk-dsh-observer'){throw 'Observer原依赖身份缺失'}
   $observerProof=Run-Node @($checker,'package',$ObserverPackage,$observerSource)|ConvertFrom-Json
  }
  if((Get-PSDrive D).Free-lt ((Get-Item -LiteralPath $Package).Length*10+1GB)){throw '修复安装空间不足'}
  return @{history=$history;backup=$backupProof;package=$packageProof;observer=$observerProof;maintenance=$current}
 }
 $proof=Test-StoppedRepair
 if($Check){@{mode='repair-stopped-check';writes=0;ownerLock='required-at-execution';proof=$proof}|ConvertTo-Json -Depth 10;exit 0}
 $lockProcess=Acquire-OwnerLock
 try {
  $proof=Test-StoppedRepair
  New-Item -ItemType Directory -Path $EvidenceDirectory|Out-Null
  $proof|ConvertTo-Json -Depth 10|Set-Content "$EvidenceDirectory/repair-preflight.json"
  Copy-Item -LiteralPath "$origin/control-before.json","$origin/maintenance-sealed.json","$origin/backup.json" -Destination $EvidenceDirectory
  $env:DSH_HOME='D:/dsh_home';$env:TEMP=$tempDirectory;$env:TMP=$tempDirectory
  if($lockProcess.HasExited){throw '安装前独占锁已丢失'}
  $repairPackages=@("@zzusp/dingtalk-dsh-assistant@file:$Package")+@(if($ObserverPackage){"@zzusp/dingtalk-dsh-observer@file:$ObserverPackage"})
  & $node "$profile/node_modules/@deepseek-ai/dsh/lib/bin.js" plugin --profile web add @repairPackages *> "$EvidenceDirectory/install.log"
  if($LASTEXITCODE){throw '修复安装失败，保持封存停机'}
  Run-Node @($checker,'package',$Package,$source,$installed)|Set-Content "$EvidenceDirectory/installed.json"
  if($ObserverPackage){Run-Node @($checker,'package',$ObserverPackage,$observerSource,$observerInstalled)|Set-Content "$EvidenceDirectory/observer-installed.json"}
  Assert-InputHashes
  $null=Test-StoppedRepair
  if($lockProcess.HasExited){throw '安装核验期间独占锁丢失'}
 }finally{
  $lockProcess.StandardInput.Close()
  if(-not $lockProcess.WaitForExit(10000)){throw '离线独占锁尚未释放，禁止启动'}
  $lockProcess.Dispose()
 }
 Assert-StoppedRepairProcesses $record $backupRecord
 $env:PATH=(Split-Path -Parent $node)+';'+$env:PATH
 $launch=Start-Process -FilePath 'pwsh.exe' -ArgumentList @('-NoProfile','-File',$starter) -WindowStyle Hidden -PassThru -RedirectStandardOutput "$EvidenceDirectory/start.stdout.log" -RedirectStandardError "$EvidenceDirectory/start.stderr.log"
 $inputHashes=@{};foreach($path in $deploymentInputs){$inputHashes[$path]=(Get-FileHash -LiteralPath $path).Hash}
 $launchRecord=@{repairOfLaunch=$RepairStoppedLaunch;repairOfLaunchSha256=$evidenceHashes[$RepairStoppedLaunch];observerPackage=$ObserverPackage;observerPackageSha256=$ExpectedObserverPackageSha256;directQueriesProposal=$DirectQueriesProposal;mode='maintenance';launcherPid=$launch.Id;startedAt=$launch.StartTime.ToUniversalTime().ToString('o');packageSha256=$ExpectedPackageSha256;sourceProfileSha256=$ExpectedProfileSha256;inputPaths=$deploymentInputs;inputHashes=$inputHashes;profileSha256=$ExpectedProfileSha256;backup=$record.backup;maintenanceId=$record.maintenanceId;enrollmentAutostartRestore=$false}
 $launchRecord|ConvertTo-Json|Set-Content "$EvidenceDirectory/launch.json"
 $result=Read-Deployment $launchRecord
 $result|ConvertTo-Json -Depth 10|Set-Content "$EvidenceDirectory/readback.json"
 $result|ConvertTo-Json -Depth 10
 exit 0
}
if($EnrollmentProposal -and $Bootstrap){throw '新群接入要求已有正式维护接口'}
$enrollment=if($EnrollmentProposal){Read-EnrollmentProposal}else{$null}
if(($ContinueMaintenanceId -and $null-eq $ExpectedMaintenanceRevision) -or
   (-not $ContinueMaintenanceId -and $null-ne $ExpectedMaintenanceRevision) -or
   ($Bootstrap -and ($ContinueMaintenanceId -or $HoldMaintenance))){throw '维护接续须同时提供ID与revision，且不能用于Bootstrap'}
# 留出备份实际体积、安装扩展及至少1GiB余量；不足时停止，不清理任何文件。
$backupSources=@($domain,"$runtime/artifacts")
# 任务目录容量沿用零写检查的相同排除规则，不遍历依赖链接。
$backupBytes=(@(Get-ChildItem -LiteralPath $backupSources -File -Recurse)+@(Get-ChildItem -LiteralPath $runtime,$profile -File)|Measure-Object Length -Sum).Sum
$backupBytes+=[long]$taskDirectoryProof.taskBytes
$packageBytes=[long](Get-Item -LiteralPath $Package).Length
if($ObserverPackage){$packageBytes+=[long](Get-Item -LiteralPath $ObserverPackage).Length}
$impactBackupBytes=if($MigrateMessageImpact){[long](Get-Item -LiteralPath "$runtime/control.sqlite").Length}else{0}
$requiredBytes=$impactBackupBytes+[long]$backupBytes+([long]$taskMigrationCheck.bytes)+($packageBytes*10)+1GB
$freeBytes=(Get-PSDrive D).Free
if($freeBytes-lt $requiredBytes){throw "D盘空间不足：可用 $freeBytes，所需 $requiredBytes"}
$inputHashes=@{}
foreach($path in $deploymentInputs){$inputHashes[$path]=(Get-FileHash -LiteralPath $path).Hash}
$packageProof=Run-Node @($checker,'package',$Package,$source)
$configArgs=if($DirectQueriesProposal){@("$workspace/scripts/configure-agent-query-resources.mjs",'--profile',"$profile/cordis.patch.yml",'--proposal',$DirectQueriesProposal,'--expected-sha256',$ExpectedProfileSha256)}else{@("$workspace/scripts/configure-project-local-acceptance.mjs",'--profile',"$profile/cordis.patch.yml",'--bundle',$Bundle,'--merge-policy',$MergePolicy,'--checks-proposal',$ChecksProposal,'--expected-sha256',$ExpectedProfileSha256)}
if($ObserverPackage){$observerProof=Run-Node @($checker,'package',$ObserverPackage,$observerSource)}
$configProof=Run-Node ($configArgs+@('--check'))
$storageProof=Run-Node @("$workspace/scripts/check-resident-storage.mjs",'--check','--source',"$domain/dingtalk_dsh_assistant.json")
$old=Instance
if(-not $old){throw '维护部署要求原实例可通过正式维护接口排空；离线安装须使用独立恢复runbook'}
if($Bootstrap){
 try { $null=Invoke-RestMethod http://127.0.0.1:18998/runtime/maintenance -NoProxy -TimeoutSec 20;throw '旧实例已有维护API，禁止Bootstrap' }
 catch {if([int]$_.Exception.Response.StatusCode-ne 404){throw}}
 $bootstrapProof=Run-Node @($bootstrapTool,'disable','--profile',"$profile/cordis.patch.yml",'--expected-sha256',$ExpectedProfileSha256,'--check')
 $witnessNonce=[guid]::NewGuid().ToString()
 $witnessArgs=@($bootstrapTool,'witness','--profile',"$profile/cordis.patch.yml",'--expected-sha256',$ExpectedProfileSha256,'--evidence-directory',$EvidenceDirectory,'--expected-pid',[string]$old.ProcessId,'--nonce',$witnessNonce)
 $null=Run-Node ($witnessArgs+@('--check'))
}else{
 $maintenanceBefore=Invoke-RestMethod http://127.0.0.1:18998/runtime/maintenance -NoProxy -TimeoutSec 20
 if($ContinueMaintenanceId){Assert-MaintenanceContinuation $maintenanceBefore $old}
 elseif($maintenanceBefore.active){throw '实例已有维护操作，请先核对其许可与部署记录'}
}
$beforeTasks=if($old){Invoke-RestMethod http://127.0.0.1:18998/state/tasks -NoProxy -TimeoutSec 20}else{$null}
$children=if($old){@(Get-CimInstance Win32_Process|Where-Object {$_.ParentProcessId-eq $old.ProcessId -and $_.Name-eq 'dws.exe'})}else{@()}
# 较重的在线读取和JSON序列化放在排空等待之前。
$beforeTasksJson=if($beforeTasks){$beforeTasks|ConvertTo-Json -Depth 100}else{$null}
$snapshot=Wait-DrainedSnapshot
if($Check){@{mode='check';writes=0;messageImpactMigration=@{requested=[bool]$MigrateMessageImpact;offlineCheckRequired=[bool]$MigrateMessageImpact;condition='停止原实例、禁用自启、持owner锁并checkpoint后执行零写检查'};online=[bool]$old;disk=@{freeBytes=$freeBytes;requiredBytes=$requiredBytes;backupBytes=$backupBytes};package=($packageProof|ConvertFrom-Json);tasks=($snapshot|ConvertFrom-Json).tasks.Count}|ConvertTo-Json -Depth 4;exit 0}
# 只有所有预检通过后才开始写证据和停止精确已核实进程。
Assert-InputHashes
foreach($path in $inputHashes.Keys){if((Get-FileHash -LiteralPath $path).Hash-ne $inputHashes[$path]){throw '部署输入文件已变化'}}
New-Item -ItemType Directory -Path $EvidenceDirectory|Out-Null
$maintenanceId=if($ContinueMaintenanceId){$ContinueMaintenanceId}else{'deploy-'+[guid]::NewGuid().ToString()}
$lockProcess=$null
$enrollmentAutostartRestore=$false
try {
if($Bootstrap){
 Copy-Item -LiteralPath "$profile/cordis.patch.yml" -Destination "$EvidenceDirectory/profile-original.yml"
 Same-Hash "$profile/cordis.patch.yml" "$EvidenceDirectory/profile-original.yml"
 $witness=Run-Node $witnessArgs|ConvertFrom-Json
 $null=Wait-BootstrapWitness 'ready' $old $witnessNonce
 $disabled=Run-Node @($bootstrapTool,'disable','--profile',"$profile/cordis.patch.yml",'--expected-sha256',$witness.afterSha256)|ConvertFrom-Json
 $disabled|ConvertTo-Json|Set-Content "$EvidenceDirectory/bootstrap-disabled.json"
 Wait-BootstrapResidentClosed $old
 $null=Wait-BootstrapWitness 'disposed' $old $witnessNonce
 # 端口关闭只是起点，只有拿到仍持续持有的owner锁才证明控制器退出。
 $lockProcess=Acquire-OwnerLock
 $snapshot=Wait-DrainedSnapshot
 $configArgs[$configArgs.Count-1]=$disabled.afterSha256
}else{
$entered=if($ContinueMaintenanceId){
 $currentMaintenance=Invoke-RestMethod http://127.0.0.1:18998/runtime/maintenance -NoProxy -TimeoutSec 20
 Assert-MaintenanceContinuation $currentMaintenance $old
 @{state=$currentMaintenance}
}else{Change-Maintenance $maintenanceBefore $true $maintenanceId}
$entered|ConvertTo-Json -Depth 8|Set-Content -LiteralPath "$EvidenceDirectory/maintenance.json" -Encoding utf8
if($enrollment){Ensure-EnrollmentSubscription $enrollment}
try {$snapshot=Wait-DrainedSnapshot}catch{
 if($ContinueMaintenanceId){throw '维护接续排空失败，保留原维护状态，本次未停机'}
 [void](Change-Maintenance $entered.state $false $maintenanceId)
 throw '维护排空未完成，已恢复原实例派发，本次未停机'
}
$sealed=Change-MaintenancePhase $entered.state 'seal' $maintenanceId
if(-not $sealed.state.stopPermitted -or $sealed.state.maintenanceId-ne $maintenanceId -or $sealed.state.processIncarnation -notmatch ('^'+[regex]::Escape([string]$old.ProcessId)+':')){throw '未取得绑定原进程的封存停机许可'}
$sealed|ConvertTo-Json -Depth 8|Set-Content -LiteralPath "$EvidenceDirectory/maintenance-sealed.json" -Encoding utf8
$snapshot=Wait-DrainedSnapshot
$sealedSnapshot=($snapshot|ConvertFrom-Json).maintenance
if($sealedSnapshot.phase-ne 'stopping' -or $sealedSnapshot.maintenanceId-ne $maintenanceId -or $sealedSnapshot.revision-ne $sealed.state.revision){throw '封存停机许可漂移'}
}
$snapshot|Set-Content -LiteralPath "$EvidenceDirectory/control-before.json" -Encoding utf8
if($beforeTasksJson){$beforeTasksJson|Set-Content -LiteralPath "$EvidenceDirectory/tasks-before.json" -Encoding utf8}
if($old){
 $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($old.ProcessId)"
 if(-not $current -or $current.CreationDate-ne $old.CreationDate){throw '停止前进程身份漂移'}
 # 停止前最后一次只读检查；新 attempt 已领取或历史变化时不停止实例。
 try {$lastSnapshot=Run-Node @($checker,'snapshot')} catch {
  @{status='not-deployed';stopped=$false;reason='停止前任务重新执行或未排空；本次未停止实例，请等待安全窗口并使用新证据目录'}|ConvertTo-Json
  exit 2
 }
 if($lastSnapshot-ne $snapshot){
  @{status='not-deployed';stopped=$false;reason='停止前控制快照已变化；本次未停止实例，请重新check并使用新证据目录'}|ConvertTo-Json
  exit 2
 }
 if($Bootstrap){Wait-BootstrapResidentClosed $old;if($lockProcess.HasExited){throw '首次切换独占锁已丢失'}}
 if($enrollment -or $MigrateMessageImpact){
  $scheduled=@(Get-ScheduledTask -TaskName $enrollmentTaskName -ErrorAction Stop)
  if($scheduled.Count-ne 1){throw '新群接入自启任务身份不唯一'}
  $enrollmentAutostartRestore=[string]$scheduled[0].State-ne 'Disabled'
  if($enrollmentAutostartRestore){$null=Disable-ScheduledTask -TaskName $enrollmentTaskName}
  if([string](Get-ScheduledTask -TaskName $enrollmentTaskName).State-ne 'Disabled'){throw '新群接入前自启任务未禁用'}
  @{taskName=$enrollmentTaskName;restore=$enrollmentAutostartRestore}|ConvertTo-Json|Set-Content "$EvidenceDirectory/enrollment-autostart.json"
 }
 Stop-Process -Id $old.ProcessId -Force
 foreach($child in $children){$current=Get-CimInstance Win32_Process -Filter "ProcessId=$($child.ProcessId)";if($current -and $current.CreationDate-eq $child.CreationDate){Stop-Process -Id $child.ProcessId -Force}}
}
if(@(Listeners).Count){throw '原实例仍监听；停止部署'}
# 核对停止后的控制账；unknown必须先用专用原生对账工具处理。
$stableSnapshot=Run-Node @($checker,'snapshot')
if($stableSnapshot-ne $snapshot){throw '停机期间状态变化，请重新check'}
 if(-not $lockProcess){$lockProcess=Acquire-OwnerLock}
 if(@(Listeners).Count){throw '取得锁后发现实例监听'}
 if((Run-Node @($checker,'snapshot'))-ne $snapshot){throw '取得锁后控制账漂移'}
if($enrollment -or $MigrateMessageImpact){Run-Node @($checker,'checkpoint',[string]$old.ProcessId)|Set-Content "$EvidenceDirectory/enrollment-checkpoint.json"}
if($MigrateMessageImpact){Run-Node @("$workspace/scripts/migrate-message-impact.js",'--check',"$runtime/control.sqlite")|Set-Content "$EvidenceDirectory/message-impact-check.json"}
$backup='D:/dsh_home/backups/owner-repair-'+(Get-Date -Format yyyyMMdd-HHmmss-fff)
New-Item -ItemType Directory -Path $backup,"$backup/runtime","$backup/profile"|Out-Null
Copy-Item -LiteralPath $domain -Destination "$backup/domain" -Recurse
Get-ChildItem -LiteralPath $runtime -File|Copy-Item -Destination "$backup/runtime"
Copy-Item -LiteralPath "$runtime/artifacts" -Destination "$backup/runtime/artifacts" -Recurse
if($TaskDirectory){Run-Node @($checker,'task-directory-copy',$TaskDirectory,"$backup/tasks")|Out-Null}
foreach($name in @('cordis.patch.yml','cordis.yml','package.json','package-lock.json','settings.yaml','pnpm-lock.yaml')){if(Test-Path -LiteralPath "$profile/$name"){Copy-Item -LiteralPath "$profile/$name" -Destination "$backup/profile/$name";Same-Hash "$profile/$name" "$backup/profile/$name"}}
Same-Hash "$runtime/control.sqlite" "$backup/runtime/control.sqlite"
Same-Hash "$domain/dingtalk_dsh_assistant.json" "$backup/domain/dingtalk_dsh_assistant.json"
$backupProof=Run-Node @($checker,'backup-verify',$backup,$TaskDirectory)
$backupProof|Set-Content -LiteralPath "$backup/manifest.json" -Encoding utf8
@{backup=$backup;oldPid=$old.ProcessId;packageSha256=(Get-FileHash -LiteralPath $Package).Hash}|ConvertTo-Json|Set-Content "$EvidenceDirectory/backup.json"
$env:DSH_HOME='D:/dsh_home';$env:TEMP=$tempDirectory;$env:TMP=$tempDirectory
foreach($path in $inputHashes.Keys){if((Get-FileHash -LiteralPath $path).Hash-ne $inputHashes[$path]){throw '部署输入文件已变化'}}
if($lockProcess.HasExited){throw '安装前独占锁已丢失'}
$messageImpactMigrationSha256=Invoke-MessageImpactMigration
if($TaskMigrationPlan){[void](Invoke-TaskFileMigration 'execute')}
$migrationBackupManifest=if($TaskMigrationPlan){"${backup}-task-migration-source/backup-manifest.json"}else{''}
$migrationBackupSha256=if($TaskMigrationPlan){(Get-FileHash -LiteralPath $migrationBackupManifest).Hash}else{''}
@{backup=$backup;oldPid=$old.ProcessId;packageSha256=(Get-FileHash -LiteralPath $Package).Hash;taskMigrationBackupManifest=$migrationBackupManifest;taskMigrationBackupSha256=$migrationBackupSha256}|ConvertTo-Json|Set-Content "$EvidenceDirectory/backup.json"
Assert-LocalPackageSources $profile $Package $observerSourceReplacement
$installPackages=@("@zzusp/dingtalk-dsh-assistant@file:$Package")+@(if($ObserverPackage){"@zzusp/dingtalk-dsh-observer@file:$ObserverPackage"})
& $node "$profile/node_modules/@deepseek-ai/dsh/lib/bin.js" plugin --profile web add @installPackages *> "$EvidenceDirectory/install.log"
if($LASTEXITCODE){throw '安装失败，保持停机并保留备份'}
Run-Node ($configArgs+@('--apply'))|Set-Content "$EvidenceDirectory/config-applied.json"
Run-Node @($checker,'package',$Package,$source,$installed)|Set-Content "$EvidenceDirectory/installed.json"
if($ObserverPackage){Run-Node @($checker,'package',$ObserverPackage,$observerSource,$observerInstalled)|Set-Content "$EvidenceDirectory/observer-installed.json"}
} finally {
 if($lockProcess){
 $lockProcess.StandardInput.Close()
 if(-not $lockProcess.WaitForExit(10000)){throw '离线独占锁尚未释放，禁止启动'}
 $lockProcess.Dispose()
 }
}
if($enrollment){
 $profileHash=(Get-FileHash -LiteralPath "$profile/cordis.patch.yml").Hash.ToLowerInvariant()
 $enrollArgs=@("$workspace/scripts/cutover-message-workflow.mjs",'--enroll-empty-group','--legacy',"$domain/dingtalk_dsh_assistant.json",'--journal',"$domain/dingtalk_dsh_assistant.workflow-seal.json",'--db',"$runtime/control.sqlite",'--artifacts',"$runtime/artifacts",'--instance','dsh-web-runtime-v2-20260924','--group',$enrollment.groupId,'--profile',"$profile/cordis.patch.yml",'--expected-profile-sha256',$profileHash,'--runtime-pid',[string]$old.ProcessId,'--runtime-port','18998','--scheduled-task',$enrollmentTaskName)
 Run-Node ($enrollArgs+@('--check'))|Set-Content "$EvidenceDirectory/enrollment-check.json"
 Run-Node ($enrollArgs+@('--execute'))|Set-Content "$EvidenceDirectory/enrollment-applied.json"
}
if($Bootstrap){
 if(@(Listeners).Count -or (Get-CimInstance Win32_Process -Filter "ProcessId=$($old.ProcessId)" -ErrorAction SilentlyContinue)){throw '离线维护前发现旧实例'}
 $disabledHash=(Get-FileHash -LiteralPath "$profile/cordis.patch.yml").Hash.ToLowerInvariant()
 Run-Node @($bootstrapTool,'seal-offline','--profile',"$profile/cordis.patch.yml",'--expected-sha256',$disabledHash,'--installed',$installed,'--maintenance-id',$maintenanceId)|Set-Content "$EvidenceDirectory/bootstrap-maintenance-sealed.json"
 Run-Node @($bootstrapTool,'enable','--profile',"$profile/cordis.patch.yml",'--expected-sha256',$disabledHash)|Set-Content "$EvidenceDirectory/bootstrap-enabled.json"
}
# 启动前核对本次离线迁移证明；失败保持停机，不自动恢复自启。
[void](Assert-MessageImpactReadback @{messageImpactMigrationSha256=$messageImpactMigrationSha256})
# 用既有启动脚本，不创建或改写计划任务；仅当前进程树使用D盘TEMP。
$env:PATH=(Split-Path -Parent $node)+';'+$env:PATH
$launch=Start-Process -FilePath 'pwsh.exe' -ArgumentList @('-NoProfile','-File',$starter) -WindowStyle Hidden -PassThru -RedirectStandardOutput "$EvidenceDirectory/start.stdout.log" -RedirectStandardError "$EvidenceDirectory/start.stderr.log"
$launchRecord=@{messageImpactMigrationSha256=$messageImpactMigrationSha256;taskMigrationBackupManifest=$migrationBackupManifest;taskMigrationBackupSha256=$migrationBackupSha256;taskMigrationPlan=$TaskMigrationPlan;taskMigrationJournalSha256=if($TaskMigrationPlan){(Get-FileHash -LiteralPath "$EvidenceDirectory/task-file-migration.json").Hash}else{''};observerPackage=$ObserverPackage;observerPackageSha256=$ExpectedObserverPackageSha256;directQueriesProposal=$DirectQueriesProposal;mode=if($Bootstrap){'bootstrap'}else{'maintenance'};launcherPid=$launch.Id;startedAt=$launch.StartTime.ToUniversalTime().ToString('o');packageSha256=(Get-FileHash -LiteralPath $Package).Hash;sourceProfileSha256=$ExpectedProfileSha256;inputPaths=$deploymentInputs;inputHashes=$inputHashes;profileSha256=(Get-FileHash -LiteralPath "$profile/cordis.patch.yml").Hash;backup=$backup;maintenanceId=$maintenanceId;enrollmentAutostartRestore=$enrollmentAutostartRestore}
$launchRecord|ConvertTo-Json|Set-Content -LiteralPath "$EvidenceDirectory/launch.json" -Encoding utf8
$result=Read-Deployment $launchRecord
if($result.ready -and -not $HoldMaintenance){$result=Resume-Deployment $result $launchRecord}
$result|ConvertTo-Json -Depth 10|Set-Content -LiteralPath "$EvidenceDirectory/readback.json" -Encoding utf8
$result|ConvertTo-Json -Depth 10
