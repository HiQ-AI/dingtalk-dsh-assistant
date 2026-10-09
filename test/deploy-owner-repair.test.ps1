$ErrorActionPreference='Stop'
$errors=$null;$tokens=$null
$path=Join-Path $PSScriptRoot '../docs/acceptance/topic-context-completeness/scripts/deploy-owner-repair.ps1'
$ast=[System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
if($errors.Count){throw '脚本解析失败'}
$dependencyReadbackFunction=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq 'Assert-RequiredDependencyReadback'},$true)
Invoke-Expression $dependencyReadbackFunction.Extent.Text
$restoreReadbackFunction=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq 'Assert-ConfigurationRestoreReadback'},$true)
Invoke-Expression $restoreReadbackFunction.Extent.Text
$MigrateMessageImpact=$false
 $MigrateExecutionEventsIndex=$false
 $indexReadbackFunction=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq 'Assert-ExecutionEventsIndexReadback'},$true)
 Invoke-Expression $indexReadbackFunction.Extent.Text
 $controlReadbackFunction=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq 'Assert-DeploymentControlRecord'},$true)
 Invoke-Expression $controlReadbackFunction.Extent.Text
$impactReadbackFunction=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq 'Assert-MessageImpactReadback'},$true)
Invoke-Expression $impactReadbackFunction.Extent.Text
$workspaceAssignment=$ast.Find({param($item) $item -is [System.Management.Automation.Language.AssignmentStatementAst] -and $item.Left.Extent.Text-eq '$workspace'},$true)
$deployedScriptRoot=Split-Path -Parent ([IO.Path]::GetFullPath($path))
$resolvedWorkspace=Invoke-Expression ($workspaceAssignment.Right.Extent.Text.Replace('$PSScriptRoot','$deployedScriptRoot'))
if($resolvedWorkspace-ne [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).Replace('\','/').TrimEnd('/')){throw '部署源码必须来自脚本所在检出'}
Write-Output 'PASS 1/1: 部署工作区由脚本位置解析，不绑定历史worktree'
$continuationFunction=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq 'Assert-MaintenanceContinuation'},$true)
Invoke-Expression $continuationFunction.Extent.Text
$ContinueMaintenanceId='recovery';$ExpectedMaintenanceRevision=28
$continuationState=@{active=$true;phase='draining';drained=$true;maintenanceId='recovery';revision=28;processIncarnation='6012:instance'}
Assert-MaintenanceContinuation $continuationState @{ProcessId=6012}
foreach($case in @(@{revision=29},@{maintenanceId='other'},@{drained=$false},@{phase='stopping'},@{active=$false},@{processIncarnation='6013:instance'})){
 $changed=$continuationState.Clone();foreach($key in $case.Keys){$changed[$key]=$case[$key]}
 $rejected=$false;try{Assert-MaintenanceContinuation $changed @{ProcessId=6012}}catch{$rejected=$true}
 if(-not $rejected){throw '接续维护必须拒绝漂移或未排空状态'}
}
$sealedContinuation=$continuationState.Clone();$sealedContinuation.phase='stopping';$sealedContinuation.stopPermitted=$true;$sealedContinuation.sealedIncarnation=$sealedContinuation.processIncarnation
Assert-MaintenanceContinuation $sealedContinuation @{ProcessId=6012}
foreach($case in @(@{stopPermitted=$false},@{sealedIncarnation='6012:other'},@{processIncarnation='6013:instance'},@{revision=29})){
 $changed=$sealedContinuation.Clone();foreach($key in $case.Keys){$changed[$key]=$case[$key]}
 $rejected=$false;try{Assert-MaintenanceContinuation $changed @{ProcessId=6012}}catch{$rejected=$true}
 if(-not $rejected){throw '已封存接续必须拒绝停机许可、封存进程或水位漂移'}
}
Write-Output 'PASS 5/5: 同PID封存许可可接续，缺停机许可及身份/版本漂移拒绝'
$ExpectedMaintenanceRevision=$null;$rejected=$false
try{Assert-MaintenanceContinuation $continuationState @{ProcessId=6012}}catch{$rejected=$true}
if(-not $rejected){throw '接续维护不得缺失revision'}
Write-Output 'PASS 8/8: 接续许可匹配通过；版本/ID/排空/阶段/active/PID漂移及缺少revision拒绝'
$function=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq 'Read-Deployment'},$true)
Invoke-Expression $function.Extent.Text
$launchIdentityFunction=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq 'Assert-DeploymentLaunchProcess'},$true)
Invoke-Expression $launchIdentityFunction.Extent.Text
$WaitSeconds=1
$EvidenceDirectory=Join-Path $PSScriptRoot ('../docs/tmp/readback-fixture-'+[guid]::NewGuid())
function Listeners { @() }
$result=Read-Deployment @{launcherPid=123;startedAt=(Get-Date).ToUniversalTime().ToString('o')}
if($result.status-ne 'pending' -or $result.ready -or $result.restartAttempted -or (Test-Path -LiteralPath $EvidenceDirectory)){throw '未就绪必须零写pending，禁止重启'}
function Listeners { @(3080,18998) }
function Instance { @{CreationDate=(Get-Date);ParentProcessId=456;ProcessId=789} }
$rejected=$false
try {Read-Deployment @{launcherPid=123;startedAt=(Get-Date).AddMinutes(-1).ToUniversalTime().ToString('o')}}catch{$rejected=$_.Exception.Message-eq '监听进程并非此次启动实例'}
if(-not $rejected){throw '不得接受另一进程的双端口'}
Write-Output 'PASS 2/2: pending零写无重启；双端口进程身份错配拒绝'

$waitFunction=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq 'Wait-DrainedSnapshot'},$true)
Invoke-Expression $waitFunction.Extent.Text
$node='Mock-SnapshotNode';$checker='unused';$script:calls=0
function Mock-SnapshotNode {
 $script:calls++
 if($script:calls-eq 1){$global:LASTEXITCODE=1;'DEPLOY_NOT_DRAINED:nodes=1,owners=0,effects=0,messages=0'}else{$global:LASTEXITCODE=0;'{"tasks":[]}'}
}
function Start-Sleep {}
if((Wait-DrainedSnapshot)-ne '{"tasks":[]}' -or $script:calls-ne 2){throw '未按精确排空错误重试'}
$script:calls=0
function Mock-SnapshotNode {$script:calls++;$global:LASTEXITCODE=1;'SQLITE_BUSY'}
$failed=$false
try {Wait-DrainedSnapshot}catch{$failed=$true}
if(-not $failed -or $script:calls-ne 1){throw '其他错误必须立即失败'}
Write-Output 'PASS 2/2: 精确排空错误重试；其他错误立即失败'

# stdout/stderr被独占写入时，不读内容也不以日志哈希阻断回读。
function Listeners { @() }
$EvidenceDirectory=Join-Path $PSScriptRoot ('../docs/tmp/readback-locked-log-'+[guid]::NewGuid())
[IO.Directory]::CreateDirectory($EvidenceDirectory)|Out-Null
$streams=@()
try {
 foreach($name in @('start.stdout.log','start.stderr.log')){
  $stream=[IO.File]::Open((Join-Path $EvidenceDirectory $name),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  $stream.WriteByte(65);$stream.Flush();$streams+=$stream
 }
 $result=Read-Deployment @{launcherPid=123;startedAt=(Get-Date).ToUniversalTime().ToString('o')}
 if($result.status-ne 'pending' -or $result.logs.Count-ne 2 -or @($result.logs|Where-Object { $_.ContainsKey('sha256') -or -not $_.live -or $_.bytes-ne 1 }).Count){throw '独占日志不能阻断回读或声称固定哈希'}
} finally {foreach($stream in $streams){$stream.Dispose()}}
Write-Output 'PASS 1/1: stdout/stderr独占写句柄不阻断元信息回读'

$hashFunction=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq 'Assert-InputHashes'},$true)
Invoke-Expression $hashFunction.Extent.Text
$profile='profile-root';$Package='candidate.tgz';$ExpectedProfileSha256='a'*64;$ExpectedPackageSha256='b'*64
function Get-FileHash {param($LiteralPath) @{Hash=if($LiteralPath-eq 'candidate.tgz'){'b'*64}else{'a'*64}}}
Assert-InputHashes
$ExpectedPackageSha256='a'*64;$failed=$false
try {Assert-InputHashes}catch{$failed=$_.Exception.Message-eq 'package SHA不匹配'}
if(-not $failed){throw '包与配置摘要对调必须在零写阶段拒绝'}
$ExpectedPackageSha256='b'*64;$ExpectedProfileSha256='b'*64;$failed=$false
try {Assert-InputHashes}catch{$failed=$_.Exception.Message-eq 'profile CAS不匹配'}
if(-not $failed){throw '配置摘要错误必须在零写阶段拒绝'}
Write-Output 'PASS 3/3: 双摘要正确通过；包摘要错误拒绝；配置摘要错误拒绝'

foreach($name in @('Test-MaintenanceBackfillPause','Change-MaintenancePhase','Read-DeploymentRuntime','Resume-Deployment','Assert-LaunchInputs','Restore-EnrollmentAutostart','Read-EnrollmentProposal','Ensure-EnrollmentSubscription')){
 $fn=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq $name},$true)
 Invoke-Expression $fn.Extent.Text
}
$pauseHealth=@{status='degraded';transport='dws';inboundConfigured=$true;executionStore=@{healthy=$true};recoveryIssueCount=0;dwsBridge=@{humanReplies=@{state='ready'};groups=@(@{listener=@{state='ready'};backfill=@{state='failed';lastError='RUNTIME_MAINTENANCE_ACTIVE'}})}}
$pauseMaintenance=@{active=$true;phase='stopping';drained=$true;resumePermitted=$true;sealedIncarnation='old';processIncarnation='new';busy=@{nodes=0;owners=0;effects=0;messages=0}}
if(-not (Test-MaintenanceBackfillPause $pauseHealth $pauseMaintenance)){throw '维护暂停应可恢复'}
foreach($fault in @('auth','listener','store','recovery','busy','incarnation','inactive')){
 $h=$pauseHealth|ConvertTo-Json -Depth 10|ConvertFrom-Json -AsHashtable
 $m=$pauseMaintenance|ConvertTo-Json -Depth 10|ConvertFrom-Json -AsHashtable
 switch($fault){
 auth {$h.dwsBridge.groups[0].backfill.lastError='AUTH_FAILED'}
 listener {$h.dwsBridge.groups[0].listener.state='failed'}
 store {$h.executionStore.healthy=$false}
 recovery {$h.recoveryIssueCount=1}
 busy {$m.busy.nodes=1}
 incarnation {$m.processIncarnation='old'}
 inactive {$m.active=$false}
 }
 if(Test-MaintenanceBackfillPause $h $m){throw "错误放行: $fault"}
}
Write-Output 'PASS 8/8: maintenance-only backfill predicate and seven rejection cases'
$script:requests=@();$script:maintenance=@{active=$true;resumePermitted=$false;maintenanceId='deploy';revision=2}
function Invoke-RestMethod {
 param($Uri,$Method,$ContentType,$Headers,$Body,$TimeoutSec,[switch]$NoProxy)
 if($Method-eq 'Post'){
  $script:requests+=@{uri=$Uri;body=($Body|ConvertFrom-Json)}
  if($Uri.EndsWith('/resume')){$script:maintenance=@{active=$false;maintenanceId='deploy';revision=3}}
  return @{state=$script:maintenance}
 }
 if($Uri.EndsWith('/health')){if($script:healthFailure){return @{status='degraded'}};return @{status='ok'}}
 if($script:storeFailure -and -not $script:maintenance.active){throw 'STORE_UNAVAILABLE'}
 return $script:maintenance
}
$failed=$false
try {Resume-Deployment @{ready=$true} @{maintenanceId='deploy'}}catch{$failed=$_.Exception.Message-eq '当前实例不具备封存许可恢复资格'}
if(-not $failed -or $script:requests.Count){throw '旧进程不得提交恢复'}
$script:maintenance.resumePermitted=$true
$result=Resume-Deployment @{ready=$true} @{maintenanceId='deploy'}
if(-not $result.dispatchResumed -or $script:requests.Count-ne 1 -or -not $script:requests[0].uri.EndsWith('/resume') -or $script:requests[0].body.PSObject.Properties.Name-contains 'active'){throw '必须走封存许可恢复接口'}
foreach($fault in @('health','store')) {
 $script:maintenance=@{active=$true;resumePermitted=$true;maintenanceId='deploy';revision=2}
 $script:healthFailure=$fault-eq 'health';$script:storeFailure=$fault-eq 'store'
 $candidate=@{ready=$true};$failed=$false
 try{Resume-Deployment $candidate @{maintenanceId='deploy'}}catch{$failed=$_.Exception.Message-in @('部署运行健康检查失败','STORE_UNAVAILABLE')}
 if(-not $failed -or $candidate.dispatchResumed){throw '恢复后health/store故障不得报告派发确认'}
}
$script:healthFailure=$false;$script:storeFailure=$false
Write-Output 'PASS 2/2: 恢复后健康异常或store不可用拒绝成功，不重试恢复'
$ExpectedProfileSha256='a'*64;$ExpectedPackageSha256='b'*64;$Bundle='bundle.json';$MergePolicy='policy.json';$ChecksProposal='checks.json'
$record=@{sourceProfileSha256='a'*64;packageSha256='b'*64;inputPaths=@($Bundle,$MergePolicy,$ChecksProposal);inputHashes=@{'bundle.json'='a'*64;'policy.json'='a'*64;'checks.json'='a'*64}}
Assert-LaunchInputs $record
$ExpectedProfileSha256='c'*64;$failed=$false
try {Assert-LaunchInputs $record}catch{$failed=$_.Exception.Message-eq '接续参数与原部署输入不一致'}
if(-not $failed){throw '接续不得替换原摘要'}
Write-Output 'PASS 4/4: 旧进程不得恢复；新进程经resume恢复；接续输入匹配；接续输入漂移拒绝'

$fn=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq 'Wait-BootstrapResidentClosed'},$true)
Invoke-Expression $fn.Extent.Text
$stamp=Get-Date
$old=@{ProcessId=123;CreationDate=$stamp}
function Get-CimInstance {param($Filter) @{ProcessId=123;CreationDate=$stamp}}
function Listeners { @(@{LocalPort=3080;OwningProcess=123;LocalAddress='127.0.0.1'}) }
Wait-BootstrapResidentClosed $old
function Listeners { @(@{LocalPort=3080;OwningProcess=999;LocalAddress='127.0.0.1'}) }
$failed=$false
try {Wait-BootstrapResidentClosed $old}catch{$failed=$_.Exception.Message-eq '首次切换3080归属漂移'}
if(-not $failed){throw 'bootstrap不能接受另一PID的3080'}
function Get-CimInstance {param($Filter) @{ProcessId=123;CreationDate=$stamp.AddSeconds(1)}}
$failed=$false
try {Wait-BootstrapResidentClosed $old}catch{$failed=$_.Exception.Message-eq '首次切换旧进程身份漂移'}
if(-not $failed){throw 'bootstrap不能接受复用PID'}
Write-Output 'PASS 3/3: bootstrap Resident退出；3080归属漂移拒绝；PID复用拒绝'

$EnrollmentProposal='proposal.json'
function Get-Content {param($LiteralPath,[switch]$Raw) '{"groupId":"test-group","name":"测试群","responsibility":"仅测试"}'}
$proposal=Read-EnrollmentProposal
if($proposal.groupId-ne 'test-group'){throw '新群提案解析错误'}
function Get-Content {param($LiteralPath,[switch]$Raw) '{"groupId":"test-group","name":"测试群","responsibility":"仅测试","command":"unexpected"}'}
$failed=$false;try{Read-EnrollmentProposal}catch{$failed=$true}
if(-not $failed){throw '新群提案不得接受额外执行参数'}
$script:groupRead=@();$script:subscriptions=0
function Invoke-RestMethod {
 param($Uri,$Method,$ContentType,$Headers,$Body,$TimeoutSec,[switch]$NoProxy)
 if($Method-eq 'Post'){$script:subscriptions++;$script:groupRead=@(($Body|ConvertFrom-Json));return}
 Write-Output -NoEnumerate $script:groupRead
}
Ensure-EnrollmentSubscription $proposal
Ensure-EnrollmentSubscription $proposal
if($script:subscriptions-ne 1){throw '重复检查不得重新订阅'}
$script:groupRead[0].name='changed'
$failed=$false;try{Ensure-EnrollmentSubscription $proposal}catch{$failed=$true}
if(-not $failed -or $script:subscriptions-ne 1){throw '已有群配置漂移必须拒绝'}
$enrollmentTaskName='test-task';$script:taskState='Running';$script:taskEnabled=$false;$script:enabled=0
function Get-ScheduledTask {param($TaskName) @{State=$script:taskState;Settings=@{Enabled=$script:taskEnabled}}}
function Enable-ScheduledTask {param($TaskName) $script:enabled++;$script:taskEnabled=$true}
Restore-EnrollmentAutostart @{enrollmentAutostartRestore=$false}
if($script:enabled){throw '原先禁用的任务不得启用'}
Restore-EnrollmentAutostart @{enrollmentAutostartRestore=$true}
Restore-EnrollmentAutostart @{enrollmentAutostartRestore=$true}
if($script:enabled-ne 1){throw '只恢复一次原有自启'}
Write-Output 'PASS 6/6: 新群提案精确字段、订阅幂等/漂移拒绝、原自启状态保留与幂等恢复'

$modeFunction=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq 'Assert-DeploymentMode'},$true)
Invoke-Expression $modeFunction.Extent.Text
$DirectQueriesProposal='proposal.json';$Bundle='';$MergePolicy='';$ChecksProposal='';$Bootstrap=$false;$ObserverPackage='observer.tgz';$ExpectedObserverPackageSha256='c'*64
Assert-DeploymentMode
$Bundle='old.json';$rejected=$false;try{Assert-DeploymentMode}catch{$rejected=$true};if(-not $rejected){throw '模式必须互斥'}
$Bundle='';$ExpectedObserverPackageSha256='';$rejected=$false;try{Assert-DeploymentMode}catch{$rejected=$true};if(-not $rejected){throw 'Observer摘要不可省略'}
$ObserverPackage='';$DirectQueriesProposal='';Assert-DeploymentMode
$DirectQueriesProposal='proposal.json';$ObserverPackage='observer.tgz';$ExpectedObserverPackageSha256='c'*64
$Package='candidate.tgz';$ExpectedPackageSha256='b'*64;$ExpectedProfileSha256='a'*64
function Get-FileHash {param($LiteralPath) @{Hash=if($LiteralPath-eq 'candidate.tgz'){'b'*64}elseif($LiteralPath-eq 'observer.tgz'){'c'*64}else{'a'*64}}}
Assert-InputHashes
$ExpectedObserverPackageSha256='d'*64;$rejected=$false;try{Assert-InputHashes}catch{$rejected=$true};if(-not $rejected){throw 'Observer摘要漂移必须拒绝'}
Write-Output 'PASS 6/6: 查询模式、工程互斥、Observer配对、Package-only与Observer摘要门禁'

# 看板已按逻辑任务合并：旧物理ID必须指向看板内的当前任务，不能只放宽身份检查。
$identityLoop=$function.Body.Find({param($item) $item -is [System.Management.Automation.Language.ForEachStatementAst] -and $item.Variable.VariablePath.UserPath-eq 'id'},$true)
if(-not $identityLoop){throw '缺少任务身份校验'}
$script:aliasResponse=@{requestedTaskId='old';logicalTaskId='logical';taskId='latest';latestTaskId='latest'}
$script:aliasReads=0
function Invoke-RestMethod {param($Uri,[switch]$NoProxy,$TimeoutSec) $script:aliasReads++;$script:aliasResponse}
$snapshot=@{tasks=@('latest','old')};$ids=@('latest')
Invoke-Expression $identityLoop.Extent.Text
if($script:aliasReads-ne 1){throw '只核对看板未直接返回的旧身份'}
foreach($change in @(@{requestedTaskId='wrong'},@{logicalTaskId=''},@{taskId='other'},@{latestTaskId='other'},@{taskId='missing';latestTaskId='missing'})){
 $script:aliasResponse=@{requestedTaskId='old';logicalTaskId='logical';taskId='latest';latestTaskId='latest'}
 foreach($key in $change.Keys){$script:aliasResponse[$key]=$change[$key]}
 $rejected=$false;try{Invoke-Expression $identityLoop.Extent.Text}catch{$rejected=$_.Exception.Message-eq '在线Task身份缺失'}
 if(-not $rejected){throw '旧身份别名错配必须拒绝'}
}
Write-Output 'PASS 6/6: 看板合并后的旧身份别名通过；请求/逻辑/当前/最新/看板身份错配拒绝'

$permitFunction=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq 'Assert-StoppedRepairPermit'},$true)
Invoke-Expression $permitFunction.Extent.Text
$ExpectedProfileSha256='profile';$ExpectedPackageSha256='new';$DirectQueriesProposal='D:/query.json'
function Get-FileHash {param($LiteralPath) @{Hash='profile'}}
$record=[pscustomobject]@{mode='maintenance';profileSha256='profile';sourceProfileSha256='profile';backup='backup';packageSha256='old';directQueriesProposal='D:\query.json';maintenanceId='maintenance'}
$state=[pscustomobject]@{active=$true;phase='stopping';drained=$true;maintenanceId='maintenance';revision=110;sealedIncarnation='123:identity';stopPermitted=$true;busy=[pscustomobject]@{nodes=0;owners=0;effects=0;messages=0}}
$sealed=[pscustomobject]@{state=$state};$before=[pscustomobject]@{maintenance=$state};$backupRecord=[pscustomobject]@{backup='backup';packageSha256='old';oldPid=123}
Assert-StoppedRepairPermit $record $sealed $before $backupRecord $state
foreach($change in @(@{active=$false},@{phase='draining'},@{drained=$false},@{revision=111},@{maintenanceId='other'},@{sealedIncarnation='124:other'},@{busy=[pscustomobject]@{nodes=1;owners=0;effects=0;messages=0}})){
 $current=$state.PSObject.Copy();foreach($key in $change.Keys){$current.$key=$change[$key]}
 $rejected=$false;try{Assert-StoppedRepairPermit $record $sealed $before $backupRecord $current}catch{$rejected=$true}
 if(-not $rejected){throw '离线修复必须拒绝封存许可变化'}
}
Write-Output 'PASS 8/8: 原封存许可通过；active/phase/drained/revision/ID/incarnation/busy变化拒绝'

# 只有新完整历史备份进入容量扫描；其它模式保留控制快照/原清单核验。
$fullHistoryBackupScan=$true
$taskProofAssignment=$ast.Find({param($item) $item -is [System.Management.Automation.Language.AssignmentStatementAst] -and $item.Left.Extent.Text-eq '$taskDirectoryProof'},$true)
$TaskDirectory='D:/fixture-agent/tasks';$checker='checker.mjs';$script:taskCheckCalls=0
function Run-Node([string[]]$Arguments){
 $script:taskCheckCalls++
 if(($Arguments -join '|')-ne 'checker.mjs|task-directory-check|D:/fixture-agent/tasks'){throw '任务目录检查参数不匹配'}
 '{"taskDirectory":"D:/fixture-agent/tasks","taskArtifactRefs":1,"writes":0}'
}
Invoke-Expression $taskProofAssignment.Extent.Text
if($script:taskCheckCalls-ne 1 -or $taskDirectoryProof.writes-ne 0){throw '任务目录须经只读检查'}
function Run-Node([string[]]$Arguments){throw 'BACKUP_TASK_DIRECTORY_REQUIRED'}
$failed=$false
try{Invoke-Expression $taskProofAssignment.Extent.Text}catch{$failed=$_.Exception.Message-eq 'BACKUP_TASK_DIRECTORY_REQUIRED'}
if(-not $failed){throw '任务目录漏参不得继续备份'}
Write-Output 'PASS 2/2: 显式任务目录进入只读检查；缺目录失败阻断编排'

$migrationFunction=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq 'Invoke-TaskFileMigration'},$true)
Invoke-Expression $migrationFunction.Extent.Text
$backup='D:/fixture/backup'
$TaskMigrationPlan='D:/fixture/plan.json';$workspace='D:/fixture/repo';$EvidenceDirectory='D:/fixture/evidence'
$migrationToolSha256='expected'
$inputHashes=@{'D:/fixture/plan.json'='expected';'D:/fixture/repo/scripts/migrate-task-file-links.mjs'='expected'};$lockProcess=@{HasExited=$false}
$script:migrationCalls=@();$script:migrationWrites=0;$script:migrationJournalExists=$true
function Run-Node([string[]]$Arguments){$script:migrationCalls+=,$Arguments;'{"verified":true}'}
function Set-Content {param($LiteralPath,[Parameter(ValueFromPipeline)]$Value) process {$script:migrationWrites++}}
function Test-Path {param($LiteralPath,$PathType) $script:migrationJournalExists}
function Get-FileHash {param($LiteralPath) @{Hash='expected'}}
function Listeners {@()}
[void](Invoke-TaskFileMigration 'check')
if($script:migrationWrites-ne 0 -or $script:migrationCalls.Count-ne 1 -or $script:migrationCalls[0][1]-ne '--check' -or $script:migrationCalls[0].Count-ne 3){throw '迁移Check必须只读且不提供journal路径'}
$script:migrationCalls=@();[void](Invoke-TaskFileMigration 'execute')
if($script:migrationCalls[0][3]-ne 'D:/fixture/backup-task-migration-source'){throw '迁移源副本必须独立于完整backup文件集合'}
if($script:migrationWrites-ne 4 -or ($script:migrationCalls|ForEach-Object {$_[1]})-join ',' -ne '--backup,--verify-backup,--execute,--verify'){throw '迁移必须先备份独立核验、再执行独立核验并保存证据'}
$script:migrationCalls=@();$script:migrationWrites=0
[void](Invoke-TaskFileMigration 'verify' 'expected' $backup 'expected')
if($script:migrationWrites-ne 0 -or $script:migrationCalls.Count-ne 2 -or ($script:migrationCalls|ForEach-Object {$_[1]})-join ',' -ne '--verify-backup,--verify'){throw '接续迁移只读验证不能重演execute'}
$lockProcess.HasExited=$true;$failed=$false
try{Invoke-TaskFileMigration 'execute'}catch{$failed=$true}
if(-not $failed){throw '迁移不能丢失owner锁'}
$lockProcess.HasExited=$false;$inputHashes[$TaskMigrationPlan]='changed';$failed=$false
try{Invoke-TaskFileMigration 'execute'}catch{$failed=$true}
if(-not $failed){throw '迁移不能接受计划摘要漂移'}
$inputHashes[$TaskMigrationPlan]='expected';$script:migrationJournalExists=$false;$failed=$false
try{Invoke-TaskFileMigration 'verify' 'expected' $backup 'expected'}catch{$failed=$true}
if(-not $failed){throw '接续不能遗漏journal'}
$script:migrationJournalExists=$true;$script:migrationCalls=@()
function Run-Node([string[]]$Arguments){$script:migrationCalls+=,$Arguments;throw 'MIGRATION_FAILED'}
$failed=$false;try{Invoke-TaskFileMigration 'execute'}catch{$failed=$true}
if(-not $failed -or $script:migrationCalls.Count-ne 1){throw '迁移失败必须中断不能继续verify或安装'}
Write-Output 'PASS 7/7: 迁移check零写、锁内执行独立核验、接续只verify；锁丢失/计划漂移/journal缺失/执行失败拒绝'

$migrationToolSha256='different'
foreach($mode in @('check','execute','verify')) {
 $failed=$false
 try{Invoke-TaskFileMigration $mode 'expected'}catch{$failed=$_.Exception.Message-eq '任务迁移工具摘要漂移'}
 if(-not $failed){throw "迁移工具漂移未阻断 $mode"}
}
$migrationToolSha256='expected';$inputHashes['D:/fixture/repo/scripts/migrate-task-file-links.mjs']='different'
$failed=$false
try{Invoke-TaskFileMigration 'execute'}catch{$failed=$_.Exception.Message-eq '任务迁移工具冻结摘要不一致'}
if(-not $failed){throw '迁移工具与冻结输入摘要不一致未阻断'}
Write-Output 'PASS 4/4: 迁移工具Check/Execute/Verify实时摘要漂移与冻结输入不一致均拒绝'

$inputHashes['D:/fixture/repo/scripts/migrate-task-file-links.mjs']='expected'
$failed=$false
try{Invoke-TaskFileMigration 'verify' 'expected' $backup 'wrong'}catch{$failed=$_.Exception.Message-eq '任务迁移源备份清单摘要漂移'}
if(-not $failed){throw '接续不能接受迁移源备份清单摘要漂移'}
Write-Output 'PASS 2/2: 迁移源备份使用sibling目录；接续拒绝备份清单摘要漂移'

# 以下用真实本地文件与原生JSON解析验证，不替换文件系统实现。
foreach($name in @('Test-Path','Get-FileHash','Set-Content','Get-Content')){Remove-Item -LiteralPath "Function:$name" -ErrorAction SilentlyContinue}
foreach($name in @('Assert-LocalPackageSources','Assert-PersistentPackageSources','Read-StoppedRepairRecord')){
 $fn=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq $name},$true)
 Invoke-Expression $fn.Extent.Text
}
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$node=(Get-Command node.exe).Source
$fixture=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot ('../docs/tmp/sealed-install-check-'+[guid]::NewGuid())))
[IO.Directory]::CreateDirectory($fixture)|Out-Null
$persistent=Join-Path $fixture 'packages';[IO.Directory]::CreateDirectory($persistent)|Out-Null
[IO.File]::WriteAllText("$persistent/assistant.tgz",'fixture')
[IO.File]::WriteAllText("$fixture/outside.tgz",'fixture')
Assert-PersistentPackageSources $persistent @("$persistent/assistant.tgz")
$failed=$false;try{Assert-PersistentPackageSources $persistent @("$fixture/outside.tgz")}catch{$failed=$true}
if(-not $failed){throw '持久包门禁不得接受目录外路径'}
Write-Output 'PASS 2/2: 持久目录内普通包通过；目录外包拒绝'
[IO.File]::WriteAllText("$fixture/package.json",'{"dependencies":{"observer":"file:missing.tgz"}}')
[IO.File]::WriteAllText("$fixture/package-lock.json",'{"packages":{}}')
$beforeFiles=@(Get-ChildItem -LiteralPath $fixture -File|ForEach-Object {(Get-FileHash -LiteralPath $_.FullName).Hash}) -join ','
$failed=$false;try{Assert-LocalPackageSources $fixture}catch{$failed=$_.Exception.Message.StartsWith('profile本地依赖源不存在:')}
if(-not $failed -or (@(Get-ChildItem -LiteralPath $fixture -File|ForEach-Object {(Get-FileHash -LiteralPath $_.FullName).Hash}) -join ',')-ne $beforeFiles){throw '缺本地tgz须零写拒绝'}
[IO.File]::WriteAllText("$fixture/missing.tgz",'fixture')
Assert-LocalPackageSources $fixture
[IO.File]::WriteAllText("$fixture/package-lock.json",'{"packages":{"node_modules/old":{"resolved":"file:lock-only-missing.tgz"}}}')
$failed=$false;try{Assert-LocalPackageSources $fixture}catch{$failed=$_.Exception.Message.StartsWith('profile本地依赖源不存在:')}
if(-not $failed){throw '锁内独立file源缺失也必须拒绝'}
Write-Output 'PASS 3/3: package.json缺源零写拒绝、恢复文件通过、lock独立缺源拒绝'
$origin=Join-Path $fixture 'origin';$backupRoot=Join-Path $fixture 'backup'
[IO.Directory]::CreateDirectory($origin)|Out-Null
[IO.Directory]::CreateDirectory("$backupRoot/profile")|Out-Null
[IO.File]::WriteAllText("$backupRoot/profile/cordis.patch.yml",'same-profile')
$ExpectedProfileSha256=(Get-FileHash -LiteralPath "$backupRoot/profile/cordis.patch.yml").Hash
$ExpectedPackageSha256='same-package';$DirectQueriesProposal=''
$backupRecord=[pscustomobject]@{backup=$backupRoot;packageSha256=$ExpectedPackageSha256;oldPid=123}
$record=Read-StoppedRepairRecord "$origin/maintenance-sealed.json" $sealed $backupRecord
Assert-StoppedRepairPermit $record $sealed $before $backupRecord $state
if($record.checkpoint-ne 'sealed-before-launch' -or (Test-Path "$origin/launch.json")){throw '真实封存内存记录不能伪造launch'}
foreach($name in @('launch.json','config-applied.json','task-file-migration-execute.json')){
 [IO.File]::WriteAllText("$origin/$name",'{}');$failed=$false
 try{Read-StoppedRepairRecord "$origin/maintenance-sealed.json" $sealed $backupRecord}catch{$failed=$true}
 if(-not $failed){throw '已跨阶段证据必须拒绝'}
 [IO.File]::Delete("$origin/$name")
}
$ExpectedPackageSha256='other';$failed=$false
try{Read-StoppedRepairRecord "$origin/maintenance-sealed.json" $sealed $backupRecord}catch{$failed=$true}
if(-not $failed){throw 'beforelaunch不能更换原包'}
Write-Output 'PASS 5/5: 封存未launch检查点通过且不造文件；launch/config/迁移存在及包变化拒绝'


$ExpectedPackageSha256='same-package'
[IO.File]::WriteAllText("$fixture/package.json",'{"dependencies":{"@zzusp/dingtalk-dsh-observer":"file:old-observer.tgz"}}')
[IO.File]::WriteAllText("$fixture/pnpm-lock.yaml", "lockfileVersion: '9.0'`nimporters:`n  .:`n    dependencies:`n      '@zzusp/dingtalk-dsh-observer':`n        specifier: file:old-observer.tgz`npackages:`n  '@zzusp/dingtalk-dsh-observer@file:old-observer.tgz':`n    resolution: {tarball: 'file:old-observer.tgz'}`n")
Assert-LocalPackageSources $fixture '' "$fixture/missing.tgz"
[IO.File]::AppendAllText("$fixture/pnpm-lock.yaml", "  'unrelated@file:missing-other.tgz':`n    resolution: {tarball: 'file:missing-other.tgz'}`n")
$failed=$false;try{Assert-LocalPackageSources $fixture '' "$fixture/missing.tgz"}catch{$failed=$_.Exception.Message.StartsWith('profile本地依赖源不存在:')}
if(-not $failed){throw 'Observer替代不能掩盖其他锁依赖缺失'}
Write-Output 'PASS 2/2: 原生pnpm锁精确Observer替代通过；其他缺源仍拒绝'

[IO.File]::WriteAllText("$fixture/package.json",'{"dependencies":{"@zzusp/dingtalk-dsh-assistant":"file:old-assistant.tgz"}}')
[IO.File]::WriteAllText("$fixture/pnpm-lock.yaml", "lockfileVersion: '9.0'`nimporters:`n  .:`n    dependencies:`n      '@zzusp/dingtalk-dsh-assistant':`n        specifier: file:old-assistant.tgz`npackages:`n  '@zzusp/dingtalk-dsh-assistant@file:old-assistant.tgz':`n    resolution: {tarball: 'file:old-assistant.tgz'}`n")
Assert-LocalPackageSources $fixture "$fixture/missing.tgz"
$failed=$false;try{Assert-LocalPackageSources $fixture "$fixture/absent.tgz"}catch{$failed=$_.Exception.Message.StartsWith('profile本地依赖源不存在:')}
if(-not $failed){throw 'Assistant替代包本身缺失必须拒绝'}
[IO.File]::AppendAllText("$fixture/pnpm-lock.yaml", "  'unrelated@file:missing-other.tgz':`n    resolution: {tarball: 'file:missing-other.tgz'}`n")
$failed=$false;try{Assert-LocalPackageSources $fixture "$fixture/missing.tgz"}catch{$failed=$_.Exception.Message.StartsWith('profile本地依赖源不存在:')}
if(-not $failed){throw 'Assistant替代不能掩盖其他锁依赖缺失'}
Write-Output 'PASS 3/3: Assistant精确替代缺源通过；替代包缺失及其他缺源仍拒绝'

$installAssignment=$ast.Find({param($item) $item -is [System.Management.Automation.Language.AssignmentStatementAst] -and $item.Left.Extent.Text-eq '$repairPackages'},$true)
$Package='D:/candidate.tgz';$ObserverPackage='D:/packages/observer recovered.tgz'
Invoke-Expression $installAssignment.Extent.Text
if($repairPackages.Count-ne 2 -or $repairPackages[0]-ne '@zzusp/dingtalk-dsh-assistant@file:D:/candidate.tgz' -or $repairPackages[1]-ne '@zzusp/dingtalk-dsh-observer@file:D:/packages/observer recovered.tgz'){throw '修复安装须明确包名覆盖缺源依赖'}
$ObserverPackage='';Invoke-Expression $installAssignment.Extent.Text
if($repairPackages.Count-ne 1 -or $repairPackages[0]-ne '@zzusp/dingtalk-dsh-assistant@file:D:/candidate.tgz'){throw '未指定Observer时不得添加空包参数'}
$installAssignment=$ast.Find({param($item) $item -is [System.Management.Automation.Language.AssignmentStatementAst] -and $item.Left.Extent.Text-eq '$installPackages'},$true)
$ObserverPackage='D:/packages/observer recovered.tgz';Invoke-Expression $installAssignment.Extent.Text
if($installPackages.Count-ne 2 -or $installPackages[0]-ne '@zzusp/dingtalk-dsh-assistant@file:D:/candidate.tgz' -or $installPackages[1]-ne '@zzusp/dingtalk-dsh-observer@file:D:/packages/observer recovered.tgz'){throw '普通部署安装须精确指定两个包名与源'}
Write-Output 'PASS 3/3: 修复与普通安装均用精确包名覆盖旧file依赖'

# schema6只允许持锁固定动作；真实临时证明文件用于摘要漂移门禁。
Remove-Item Function:Get-FileHash -ErrorAction SilentlyContinue
$impactFunction=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq 'Invoke-MessageImpactMigration'},$true)
Invoke-Expression $impactFunction.Extent.Text
$EvidenceDirectory=Join-Path $PSScriptRoot ('../docs/tmp/impact-deploy-fixture-'+[guid]::NewGuid())
$MigrateMessageImpact=$true;$inputHashes=@{}
function Listeners {@()}
$lockProcess=@{HasExited=$true}
$failed=$false;try{Invoke-MessageImpactMigration}catch{$failed=$true}
if(-not $failed -or (Test-Path -LiteralPath $EvidenceDirectory)){throw '丢锁时必须零写拒绝'}
[IO.Directory]::CreateDirectory($EvidenceDirectory)|Out-Null
$writer=[IO.StringWriter]::new()
$lockProcess=@{HasExited=$false;StandardInput=$writer;StandardOutput=[IO.StringReader]::new('{"version":6,"verified":true,"baseline":{"message_runs":{"count":1,"sha256":"original"}}}')}
$receiptHash=Invoke-MessageImpactMigration
if($writer.ToString().Trim()-ne 'migrate-message-impact' -or -not $receiptHash){throw '只允许固定迁移动作并保存证明'}
$script:impactVerifyCalls=0
function Run-Node([string[]]$Arguments){
 if($Arguments[1]-ne 'message-impact-verify'){throw '错误回读动作'}
 $script:impactVerifyCalls++;'{"verified":true,"version":6}'
}
$record=@{messageImpactMigrationSha256=$receiptHash}
$proof=Assert-MessageImpactReadback $record
if(-not $proof.verified -or $script:impactVerifyCalls-ne 1){throw '必须独立回读schema'}
Add-Content "$EvidenceDirectory/message-impact-migration.json" ' '
$failed=$false;try{Assert-MessageImpactReadback $record}catch{$failed=$true}
if(-not $failed -or $script:impactVerifyCalls-ne 1){throw '证明漂移必须在启动或恢复前拒绝'}
$MigrateMessageImpact=$false
$failed=$false;try{Assert-MessageImpactReadback $record}catch{$failed=$true}
if(-not $failed){throw '接续不允许丢失迁移标志'}
$launchGate=$ast.Extent.Text.IndexOf('[void](Assert-MessageImpactReadback @{messageImpactMigrationSha256=')
$start=$ast.Extent.Text.IndexOf('$launch=Start-DeployedWeb', $launchGate)
if($launchGate-lt 0 -or $start-le $launchGate){throw '启动前必须存在迁移回读门禁'}
Write-Output 'PASS 6/6: schema迁移丢锁零写、固定锁内动作、独立回读、摘要漂移、模式漂移、启动前门禁'

foreach($name in @('Assert-ScheduledWebStart','Start-DeployedWeb','Restore-EnrollmentAutostart')) {
 $fn=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq $name},$true)
 Invoke-Expression $fn.Extent.Text
}
$enrollmentTaskName='DSH Web Local';$starter='D:/dsh_home/launchers/start-web.ps1';$profile='D:/dsh_home/profiles/web'
$script:startCalls=0;$script:enableCalls=0;$script:existing=@();$script:ports=@()
$script:scheduled=@{State='Ready';Settings=@{Enabled=$true};Principal=@{UserId='64554';LogonType='Interactive';RunLevel='Limited'};Actions=@(@{
 Execute='C:\Program Files\PowerShell\7\pwsh.exe';WorkingDirectory='D:\project\dingtalk-dsh-assistant'
 Arguments='-NoProfile -WindowStyle Hidden -Command "$env:DSH_HOME=''D:\dsh_home''; & ''D:\dsh_home\launchers\start-web.ps1'' -ProjectRoot ''D:\project\dingtalk-dsh-assistant'' *> ''D:\project\dingtalk-dsh-assistant\docs\tmp\dsh-web-local\web.log''"'
})}
function Get-ScheduledTask { $script:scheduled }
function Enable-ScheduledTask { $script:enableCalls++;$script:scheduled.Settings.Enabled=$true }
function Start-ScheduledTask { $script:startCalls++ }
function Get-CimInstance { $script:existing }
function Listeners { $script:ports }
[void](Assert-ScheduledWebStart)
if($script:startCalls -or $script:enableCalls){throw '计划任务Check不得产生启动或enable'}
foreach($mode in @('ordinary','repair')) {
 $launch=Start-DeployedWeb @{enrollmentAutostartRestore=$false}
 if($launch.Method-ne 'scheduled-task' -or $launch.TaskName-ne 'DSH Web Local' -or $null-ne $launch.Id){throw "$mode 启动回执不可伪造launcher PID"}
}
$script:scheduled.Settings.Enabled=$false
$failed=$false;try{Start-DeployedWeb @{enrollmentAutostartRestore=$false}}catch{$failed=$true}
if(-not $failed -or $script:enableCalls){throw '没有恢复许可不能启用计划任务'}
[void](Assert-ScheduledWebStart $true)
if($script:enableCalls){throw '有恢复许可的Check也不能enable'}
$launch=Start-DeployedWeb @{enrollmentAutostartRestore=$true}
if($script:enableCalls-ne 1 -or $script:startCalls-ne 3){throw 'Enrollment必须先恢复原启用状态再按调度入口启动'}
$originalArguments=$script:scheduled.Actions[0].Arguments
foreach($changed in @($originalArguments.Replace('D:\dsh_home','D:\other_home'),($originalArguments+'; Write-Output injected'))) {
 $script:scheduled.Actions[0].Arguments=$changed
 $failed=$false;try{Start-DeployedWeb @{enrollmentAutostartRestore=$true}}catch{$failed=$true}
 if(-not $failed -or $script:startCalls-ne 3 -or $script:enableCalls-ne 1){throw 'Action漂移必须在enable或start前拒绝'}
}
$script:scheduled.Actions[0].Arguments=$originalArguments
$script:scheduled.State='Running'
$failed=$false;try{Start-DeployedWeb @{}}catch{$failed=$true}
if(-not $failed -or $script:startCalls-ne 3){throw '运行中计划任务不得重复启动'}
$script:scheduled.State='Ready';$script:ports=@(@{LocalPort=3080})
$failed=$false;try{Start-DeployedWeb @{}}catch{$failed=$true}
if(-not $failed -or $script:startCalls-ne 3){throw '既有端口不得重复启动'}
Write-Output 'PASS: 普通/repair统一计划任务；Check零写、原许可Enrollment恢复、Action漂移、运行中与端口冲突拒绝'
foreach($field in @('UserId','LogonType','RunLevel')) {
 $saved=$script:scheduled.Principal[$field];$script:scheduled.Principal[$field]='wrong'
 $failed=$false;try{Assert-ScheduledWebStart}catch{$failed=$true}
 if(-not $failed){throw '计划任务运行身份漂移必须拒绝'}
 $script:scheduled.Principal[$field]=$saved
}
foreach($name in @('Assert-DeploymentLaunchProcess','Get-DeploymentWebLog')) {
 $fn=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq $name},$true)
 Invoke-Expression $fn.Extent.Text
}
$started=[datetime]::UtcNow.AddSeconds(-10)
$fresh=@{ParentProcessId=10;CreationDate=$started.AddSeconds(2)}
$launchRecord=@{launchMethod='scheduled-task';launchTaskName='DSH Web Local';startedAt=$started.ToString('o');launcherPid=$null}
$script:scheduled.State='Running'
$script:parent=@{ExecutablePath=$script:scheduled.Actions[0].Execute;CommandLine=$script:scheduled.Actions[0].Arguments;CreationDate=$started.AddSeconds(1)}
function Get-CimInstance { $script:parent }
function Get-ScheduledTaskInfo { @{LastRunTime=$started.AddMilliseconds(500)} }
Assert-DeploymentLaunchProcess $fresh $launchRecord
$script:parent.CommandLine='other.ps1'
$failed=$false;try{Assert-DeploymentLaunchProcess $fresh $launchRecord}catch{$failed=$true}
if(-not $failed){throw '新Node仍必须绑定计划任务的真实父进程入口'}
$script:logTime=$started.AddSeconds(3)
function Get-Item { @{LastWriteTimeUtc=$script:logTime} }
if((Get-DeploymentWebLog $launchRecord $fresh)-ne 'D:/project/dingtalk-dsh-assistant/docs/tmp/dsh-web-local/web.log'){throw '计划任务启动必须从正式日志认证Web'}
$script:logTime=$started.AddSeconds(-1)
$failed=$false;try{Get-DeploymentWebLog $launchRecord $fresh}catch{$failed=$true}
if(-not $failed){throw '旧启动日志不得作为新进程认证证明'}
Write-Output 'PASS: 运行身份/登录类型/级别、计划任务父进程入口及新进程日志时点严格校验'

$MigrateRequiredDependency=$false;$RepairStoppedLaunch='';$EvidenceDirectory='fixture';$workspace='fixture';$script:calls=0
function Test-Path {return $true}
function Get-FileHash {param($LiteralPath) @{Hash=if($LiteralPath.EndsWith('manifest.json')){'manifest'}elseif($LiteralPath.EndsWith('.mjs')){'tool'}else{'receipt'}}}
function Get-Content {return '{"migrationToolSha256":"tool","backupManifestSha256":"manifest"}'}
function Run-Node {$script:calls++;return '{"verified":true}'}
Assert-RequiredDependencyReadback @{}
if($script:calls-ne 0){throw 'ordinary called migration'}
$r=@{backupScope='required-dependency-control-only';requiredDependencyMigrationSha256='receipt';repairOfLaunch='old/launch.json';backup='backup'}
Assert-RequiredDependencyReadback $r | Out-Null
if($script:calls-ne 1){throw 'inherited receipt not verified'}
$r.requiredDependencyMigrationSha256='wrong';$rejected=$false;try{Assert-RequiredDependencyReadback $r}catch{$rejected=$true};if(-not $rejected){throw 'receipt drift allowed'}
$r.requiredDependencyMigrationSha256='receipt';$r.backupScope='full-history';$rejected=$false;try{Assert-RequiredDependencyReadback $r}catch{$rejected=$true};if(-not $rejected){throw 'wrong scope allowed'}
Write-Output 'PASS 4/4: ordinary zero migration; exact control-only repair inherited receipt; receipt drift and scope drift rejected'

$scanAssignment=$ast.Find({param($a)$a -is [System.Management.Automation.Language.AssignmentStatementAst] -and $a.Left.Extent.Text-eq '$fullHistoryBackupScan'},$true)
foreach($case in @('ordinary','dependency','readback','resume','repair','bootstrap','message','events','task-files')){
 $Readback=$false;$Resume=$false;$RepairStoppedLaunch='';$Bootstrap=$false;$MigrateMessageImpact=$false;$MigrateExecutionEventsIndex=$false;$TaskMigrationPlan='';$MigrateRequiredDependency=$false
 switch($case){'dependency'{$MigrateRequiredDependency=$true};'readback'{$Readback=$true;$MigrateMessageImpact=$true};'resume'{$Resume=$true;$MigrateExecutionEventsIndex=$true};'repair'{$RepairStoppedLaunch='old/launch.json'};'bootstrap'{$Bootstrap=$true};'message'{$MigrateMessageImpact=$true};'events'{$MigrateExecutionEventsIndex=$true};'task-files'{$TaskMigrationPlan='plan.json'}}
 Invoke-Expression $scanAssignment.Extent.Text
 if($fullHistoryBackupScan-ne ($case -in @('bootstrap','message','events','task-files'))){throw "错误历史扫描范围: $case"}
 if(-not $fullHistoryBackupScan){function Run-Node {throw '禁止扫描'};Invoke-Expression $taskProofAssignment.Extent.Text;if($taskDirectoryProof.taskBytes-ne 0){throw '普通部署不应计算历史容量'}}
}
$Readback=$false;$Resume=$false;$RepairStoppedLaunch='';$Bootstrap=$false;$MigrateMessageImpact=$false;$MigrateExecutionEventsIndex=$false;$MigrateRequiredDependency=$false;$TaskMigrationPlan='';$EnrollmentProposal='';$ContinueMaintenanceId='';$ExpectedMaintenanceRevision=$null
$ObserverPackage='';$ExpectedObserverPackageSha256='';$DirectQueriesProposal='';$Bundle='bundle.json';$MergePolicy='policy.json';$ChecksProposal='checks.json';$RepositoryPatches='patches.json';$ExpectedProfileSha256='profile';$profile='profile';$workspace='workspace'
Assert-DeploymentMode
$argsAssignment=$ast.Find({param($a)$a -is [System.Management.Automation.Language.AssignmentStatementAst] -and $a.Left.Extent.Text-eq '$configArgs'},$true)
Invoke-Expression $argsAssignment.Extent.Text
if(($configArgs -join '|')-notmatch '--repository-patches\|patches.json' -or $configArgs[-2]-ne '--expected-sha256' -or $configArgs[-1]-ne 'profile'){throw '配置器转发或停机后profile CAS位置错误'}
$inputsAssignment=$ast.Find({param($a)$a -is [System.Management.Automation.Language.AssignmentStatementAst] -and $a.Left.Extent.Text-eq '$deploymentInputs'},$true)
Invoke-Expression $inputsAssignment.Extent.Text
if($deploymentInputs-notcontains 'patches.json'){throw 'patches未绑定输入hash'}
$DirectQueriesProposal='query.json';$rejected=$false;try{Assert-DeploymentMode}catch{$rejected=$true};if(-not $rejected){throw 'query与patches应互斥'}
$DirectQueriesProposal='';$RepairStoppedLaunch='old/launch.json';$Bundle='';$MergePolicy='';$ChecksProposal='';$rejected=$false;try{Assert-DeploymentMode}catch{$rejected=$true};if(-not $rejected){throw 'repair不得追加patches'}
Write-Output 'PASS 13/13: 九种部署模式扫描边界、RepositoryPatches原生转发/CAS/hash与query/repair互斥'
# 完整原生 permit 链：限定已完成control-only迁移，保留原停机/CAS/包/profile要求。
$RepairStoppedLaunch='D:/fixture/launch.json';$ExpectedProfileSha256='profile';$ExpectedPackageSha256='new';$DirectQueriesProposal=''
function Get-FileHash {param($LiteralPath) @{Hash=if($LiteralPath.EndsWith('manifest.json')){'manifest'}elseif($LiteralPath.EndsWith('migration.json')){'receipt'}else{'profile'}}}
function Get-Content {return '{"scope":"required-dependency-control-only"}'}
function Test-Path {return $true}
function Run-Node {return '{"verified":true}'}
$r=[pscustomobject]@{mode='maintenance';profileSha256='profile';sourceProfileSha256='profile';backup='backup';packageSha256='old';directQueriesProposal='';maintenanceId='maintenance';backupScope='required-dependency-control-only';backupManifestSha256='manifest';requiredDependencyMigrationSha256='receipt'}
$br=[pscustomobject]@{backup='backup';packageSha256='old';oldPid=123;backupScope='required-dependency-control-only';backupManifestSha256='manifest'}
$state=[pscustomobject]@{active=$true;phase='stopping';drained=$true;maintenanceId='maintenance';revision=110;sealedIncarnation='123:identity';stopPermitted=$true;busy=[pscustomobject]@{nodes=0;owners=0;effects=0;messages=0}}
$sealed=[pscustomobject]@{state=$state};$before=[pscustomobject]@{maintenance=$state}
Assert-StoppedRepairPermit $r $sealed $before $br $state
foreach($change in @(@{backupScope='full-history'},@{backupManifestSha256='bad'},@{requiredDependencyMigrationSha256='bad'},@{requiredDependencyMigrationSha256=''})){
 $changed=$r.PSObject.Copy();foreach($key in $change.Keys){$changed.$key=$change[$key]};$rejected=$false;try{Assert-StoppedRepairPermit $changed $sealed $before $br $state}catch{$rejected=$true};if(-not $rejected){throw '精确control-only permit不得放行漂移或未完成迁移'}
}
Write-Output 'PASS 5/5: 完整repair permit精确继承、旧范围/manifest/收据漂移和未完成迁移拒绝'
# 配置恢复分支实执行AST：只调用原生restore，不执行plugin add。
$restoreBlock=$ast.Find({param($a)$a -is [System.Management.Automation.Language.IfStatementAst] -and $a.Extent.Text.Contains('$repairPackages=@(') -and $a.Extent.Text.Contains("'--apply'") -and $a.Clauses[0].Item1.Extent.Text-eq '$RestoreConfigurationProposal'},$true)
if(-not $restoreBlock){throw '恢复分支不可定位'}
$RestoreConfigurationProposal='restore.json';$workspace='workspace';$profile='profile';$ExpectedProfileSha256='before';$EvidenceDirectory='evidence';$script:restoreCalls=@()
function Run-Node([string[]]$Arguments){$script:restoreCalls+=,@($Arguments);return '{"mode":"apply"}'}
function Set-Content {[CmdletBinding()]param([Parameter(Position=0)]$Path,[Parameter(ValueFromPipeline)]$Value) process {}}
$node='must-not-run-plugin-installer'
Invoke-Expression $restoreBlock.Extent.Text
if($script:restoreCalls.Count-ne 1 -or $script:restoreCalls[0]-notcontains '--restore-proposal' -or $script:restoreCalls[0]-notcontains '--apply'){throw '已安装配置恢复必须仅执行一次原生restore'}
$RestoreConfigurationProposal='';$RepairStoppedLaunch='';$Bundle='bundle';$MergePolicy='merge';$ChecksProposal='checks';$RepositoryPatches='';$DirectQueriesProposal='';$ObserverPackage='';$ExpectedObserverPackageSha256='';$TaskMigrationPlan='';$Bootstrap=$false;$MigrateRequiredDependency=$false;$MigrateExecutionEventsIndex=$false;$MigrateMessageImpact=$false
$RestoreConfigurationProposal='restore.json';$rejected=$false;try{Assert-DeploymentMode}catch{$rejected=$true};if(-not $rejected){throw '不得没有原launch而恢复配置'}
$RepairStoppedLaunch='oldlaunch';$Bundle='';$MergePolicy='';$ChecksProposal='';$DirectQueriesProposal='query';$rejected=$false;try{Assert-DeploymentMode}catch{$rejected=$true};if(-not $rejected){throw '恢复配置不得混入新的query配置'}
Write-Output 'PASS 3/3: 原生restore一次、不重装；无原launch及混入其他配置拒绝'
# 新精度门禁使用计划任务秒精度；同秒允许、此前启动与错误退出码拒绝。
$timeGuard=$ast.Find({param($a)$a -is [System.Management.Automation.Language.IfStatementAst] -and $a.Clauses[0].Item1.Extent.Text.Contains('TaskResult-ne 1')},$true)
$record=[pscustomobject]@{launchMethod='scheduled-task';startedAt='2026-10-08T17:00:41.1530584Z'};$started=[datetime]$record.startedAt
$taskInfo=[pscustomobject]@{LastTaskResult=1;LastRunTime=[datetime]'2026-10-08T17:00:41Z'}
Invoke-Expression $timeGuard.Extent.Text
foreach($case in @('earlier','later','exit')){
 $taskInfo.LastRunTime=[datetime]'2026-10-08T17:00:41Z';$taskInfo.LastTaskResult=1
 if($case-eq 'earlier'){$taskInfo.LastRunTime=$taskInfo.LastRunTime.AddSeconds(-1)}
 if($case-eq 'later'){$taskInfo.LastRunTime=$taskInfo.LastRunTime.AddSeconds(1)}
 if($case-eq 'exit'){$taskInfo.LastTaskResult=0}
 $rejected=$false;try{Invoke-Expression $timeGuard.Extent.Text}catch{$rejected=$true};if(-not $rejected){throw '计划任务失败身份不精确'}
}
Write-Output 'PASS 4/4: 计划任务同秒失败允许，前后其他启动及成功退出拒绝'
