$ErrorActionPreference='Stop'
$errors=$null;$tokens=$null
$path=Join-Path $PSScriptRoot '../docs/acceptance/topic-context-completeness/scripts/deploy-owner-repair.ps1'
$ast=[System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
if($errors.Count){throw '脚本解析失败'}
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
$ExpectedMaintenanceRevision=$null;$rejected=$false
try{Assert-MaintenanceContinuation $continuationState @{ProcessId=6012}}catch{$rejected=$true}
if(-not $rejected){throw '接续维护不得缺失revision'}
Write-Output 'PASS 8/8: 接续许可匹配通过；版本/ID/排空/阶段/active/PID漂移及缺少revision拒绝'
$function=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq 'Read-Deployment'},$true)
Invoke-Expression $function.Extent.Text
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

foreach($name in @('Change-MaintenancePhase','Resume-Deployment','Assert-LaunchInputs','Restore-EnrollmentAutostart','Read-EnrollmentProposal','Ensure-EnrollmentSubscription')){
 $fn=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq $name},$true)
 Invoke-Expression $fn.Extent.Text
}
$script:requests=@();$script:maintenance=@{active=$true;resumePermitted=$false;maintenanceId='deploy';revision=2}
function Invoke-RestMethod {
 param($Uri,$Method,$ContentType,$Headers,$Body,$TimeoutSec,[switch]$NoProxy)
 if($Method-eq 'Post'){
  $script:requests+=@{uri=$Uri;body=($Body|ConvertFrom-Json)}
  if($Uri.EndsWith('/resume')){$script:maintenance=@{active=$false;maintenanceId='deploy';revision=3}}
  return @{state=$script:maintenance}
 }
 return $script:maintenance
}
$failed=$false
try {Resume-Deployment @{ready=$true} @{maintenanceId='deploy'}}catch{$failed=$_.Exception.Message-eq '当前实例不具备封存许可恢复资格'}
if(-not $failed -or $script:requests.Count){throw '旧进程不得提交恢复'}
$script:maintenance.resumePermitted=$true
$result=Resume-Deployment @{ready=$true} @{maintenanceId='deploy'}
if(-not $result.dispatchResumed -or $script:requests.Count-ne 1 -or -not $script:requests[0].uri.EndsWith('/resume') -or $script:requests[0].body.PSObject.Properties.Name-contains 'active'){throw '必须走封存许可恢复接口'}
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
$enrollmentTaskName='test-task';$script:taskState='Disabled';$script:enabled=0
function Get-ScheduledTask {param($TaskName) @{State=$script:taskState}}
function Enable-ScheduledTask {param($TaskName) $script:enabled++;$script:taskState='Ready'}
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
$ObserverPackage='';$DirectQueriesProposal='';$rejected=$false;try{Assert-DeploymentMode}catch{$rejected=$true};if(-not $rejected){throw '旧模式参数仍必填'}
$DirectQueriesProposal='proposal.json';$ObserverPackage='observer.tgz';$ExpectedObserverPackageSha256='c'*64
$Package='candidate.tgz';$ExpectedPackageSha256='b'*64;$ExpectedProfileSha256='a'*64
function Get-FileHash {param($LiteralPath) @{Hash=if($LiteralPath-eq 'candidate.tgz'){'b'*64}elseif($LiteralPath-eq 'observer.tgz'){'c'*64}else{'a'*64}}}
Assert-InputHashes
$ExpectedObserverPackageSha256='d'*64;$rejected=$false;try{Assert-InputHashes}catch{$rejected=$true};if(-not $rejected){throw 'Observer摘要漂移必须拒绝'}
Write-Output 'PASS 6/6: 查询模式、工程互斥、Observer配对、旧必填与Observer摘要门禁'

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

# TaskDirectory 检查通过正式只读 checker 传递；拒绝时不进入备份写入。
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
