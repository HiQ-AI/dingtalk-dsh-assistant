$ErrorActionPreference='Stop'
$errors=$null;$tokens=$null
$helper=Join-Path $PSScriptRoot '../docs/acceptance/topic-context-completeness/scripts/deploy-owner-repair.ps1'
$ast=[System.Management.Automation.Language.Parser]::ParseFile($helper,[ref]$tokens,[ref]$errors)
if($errors.Count){throw '部署脚本解析失败'}
$assignment=$ast.Find({param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text-eq '$historicalBackupRequired'},$true)
$Bootstrap=$false;$MigrateMessageImpact=$false;$MigrateExecutionEventsIndex=$false;$TaskMigrationPlan=''
Invoke-Expression $assignment.Extent.Text
if($historicalBackupRequired){throw '普通部署不能要求历史备份'}
$branches=$ast.FindAll({param($node) $node -is [System.Management.Automation.Language.IfStatementAst] -and $node.Clauses[0].Item1.Extent.Text-eq '$historicalBackupRequired' -and $node.Extent.Text-match 'Get-ChildItem|Copy-Item'},$true)
if($branches.Count-ne 2){throw '历史容量与复制必须仅位于两个明确迁移分支'}
$script:copies=0;$script:scans=0
function Copy-Item { $script:copies++;throw '普通部署不得复制历史树' }
function Get-ChildItem { $script:scans++;throw '普通部署不得遍历历史树' }
foreach($branch in $branches){Invoke-Expression $branch.Extent.Text}
if($script:copies -or $script:scans){throw '普通部署历史路径被访问'}
foreach($name in @('Bootstrap','MigrateMessageImpact','MigrateExecutionEventsIndex','TaskMigrationPlan')){
 Set-Variable $name $(if($name-eq 'TaskMigrationPlan'){'fixture'}else{$true})
 Invoke-Expression $assignment.Extent.Text
 if(-not $historicalBackupRequired){throw "历史迁移$name 必须保留既有备份"}
 Set-Variable $name $(if($name-eq 'TaskMigrationPlan'){''}else{$false})
}
Write-Output 'PASS 6/6: 普通部署零历史复制/遍历；四类历史迁移保留备份'
$function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name-eq 'Assert-DeploymentControlRecord'},$true)
Invoke-Expression $function.Extent.Text
$controlRecord=@{backupCreated=$false;backup='';sourceProfileSha256='profile';packageSha256='package'}
function Get-FileHash { @{Hash='control-hash'} }
function Get-Content { $controlRecord|ConvertTo-Json }
$launch=@{backupCreated=$false;deploymentControlPath='control.json';deploymentControlSha256='control-hash';sourceProfileSha256='profile';packageSha256='package'}
Assert-DeploymentControlRecord $launch
foreach($change in @(@{deploymentControlSha256='bad'},@{packageSha256='bad'},@{sourceProfileSha256='bad'},@{deploymentControlPath=''})){
 $copy=$launch.Clone();foreach($key in $change.Keys){$copy[$key]=$change[$key]}
 $rejected=$false;try{Assert-DeploymentControlRecord $copy}catch{$rejected=$true}
 if(-not $rejected){throw '普通部署控制快照身份漂移必须拒绝'}
}
Write-Output 'PASS 5/5: 控制证据通过；摘要/包/profile/路径漂移拒绝'
$text=[IO.File]::ReadAllText($helper)
foreach($needle in @('$snapshot|Set-Content -LiteralPath "$EvidenceDirectory/control-before.json"','if(-not $lockProcess){$lockProcess=Acquire-OwnerLock}',"'checkpoint',[string]`$old.ProcessId",'backupCreated=$historicalBackupRequired;deploymentControlPath=$deploymentControlPath','Assert-DeploymentControlRecord $launchRecord')){
 if(-not $text.Contains($needle)){throw "普通部署缺失原生门禁$needle"}
}
Write-Output 'PASS 5/5: 控制快照、owner锁、停机检查、Launch绑定、Readback门禁保留'

# 使用真实文件、摘要与原生 JSON，调用实际离线修复函数；不运行安装、启动或维护写接口。
foreach($name in @('Copy-Item','Get-ChildItem','Get-FileHash','Get-Content')){Remove-Item -LiteralPath "Function:$name" -ErrorAction SilentlyContinue}
foreach($name in @('Assert-StoppedRepairPermit','Assert-StoppedRepairProcesses','Test-StoppedRepair','Assert-InputHashes','Restore-EnrollmentAutostart')){
 $fn=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name-eq $name},$true)
 Invoke-Expression $fn.Extent.Text
}
$fixture=Join-Path $PSScriptRoot ('../docs/tmp/no-backup-repair-'+[guid]::NewGuid())
$profile=Join-Path $fixture 'profile';$origin=Join-Path $fixture 'origin';$EvidenceDirectory=Join-Path $fixture 'repair'
foreach($folder in @($profile,$origin,$EvidenceDirectory)){[IO.Directory]::CreateDirectory($folder)|Out-Null}
[IO.File]::WriteAllText("$profile/cordis.patch.yml",'unchanged profile')
$Package=Join-Path $fixture 'repair.tgz';[IO.File]::WriteAllText($Package,'new package')
$retainedObserverPackage=Join-Path $fixture 'observer.tgz';[IO.File]::WriteAllText($retainedObserverPackage,'same observer')
$retainedObserverPackageSha256=(Get-FileHash -LiteralPath $retainedObserverPackage).Hash
$ExpectedProfileSha256=(Get-FileHash -LiteralPath "$profile/cordis.patch.yml").Hash
$ExpectedPackageSha256=(Get-FileHash -LiteralPath $Package).Hash
$ObserverPackage='';$ExpectedObserverPackageSha256='';$DirectQueriesProposal='';$TaskDirectory='tasks';$checker='checker';$source='source';$observerSource='observer-source';$observerInstalled='observer-installed'
$controlPath=Join-Path $origin 'deployment-control.json'
$backupRecord=[pscustomobject]@{backupCreated=$false;backup='';oldPid=123;sourceProfileSha256=$ExpectedProfileSha256;packageSha256='old-package'}
$backupRecord|ConvertTo-Json|Set-Content -LiteralPath $controlPath
$record=[pscustomobject]@{backupCreated=$false;backup='';mode='maintenance';deploymentControlPath=$controlPath;deploymentControlSha256=(Get-FileHash -LiteralPath $controlPath).Hash;profileSha256=$ExpectedProfileSha256;sourceProfileSha256=$ExpectedProfileSha256;packageSha256='old-package';maintenanceId='sealed';enrollmentAutostartRestore=$true;launcherPid=456}
$state=[pscustomobject]@{active=$true;phase='stopping';drained=$true;maintenanceId='sealed';revision=42;sealedIncarnation='123:identity';stopPermitted=$true;busy=[pscustomobject]@{nodes=0;owners=0;effects=0;messages=0}}
$sealed=@{state=$state};$before=@{maintenance=$state}
Assert-StoppedRepairPermit $record $sealed $before $backupRecord $state
$cases=0
foreach($change in @(@{backup='forbidden'},@{mode='bootstrap'},@{taskMigrationPlan='migration'},@{taskMigrationBackupManifest='migration'},@{messageImpactMigrationSha256='migration'},@{executionEventsIndexMigrationSha256='migration'},@{profileSha256='drift'},@{deploymentControlSha256='drift'},@{packageSha256=$ExpectedPackageSha256})){
 $changed=$record|ConvertTo-Json|ConvertFrom-Json -AsHashtable
 foreach($key in $change.Keys){$changed[$key]=$change[$key]}
 $rejected=$false;try{Assert-StoppedRepairPermit $changed $sealed $before $backupRecord $state}catch{$rejected=$true}
 if(-not $rejected){throw "无备份修复必须拒绝 $($change.Keys)"};$cases++
}
foreach($change in @(@{active=$false},@{revision=43},@{phase='draining'},@{maintenanceId='other'},@{sealedIncarnation='124:identity'},@{drained=$false},@{busy=[pscustomobject]@{nodes=1}})){
 $changed=$state.PSObject.Copy();foreach($key in $change.Keys){$changed.$key=$change[$key]}
 $rejected=$false;try{Assert-StoppedRepairPermit $record $sealed $before $backupRecord $changed}catch{$rejected=$true}
 if(-not $rejected){throw '已恢复或变化的封存许可必须拒绝'};$cases++
}
Write-Output "PASS $($cases+1)/$($cases+1): 无备份自启恢复许可通过；迁移/包/profile/control/维护许可漂移拒绝"
$noBackupRepair=$true;$deploymentInputs=@($Package);$evidenceHashes=@{$controlPath=(Get-FileHash -LiteralPath $controlPath).Hash}
$script:commands=@();$script:live=@();$script:ports=@()
$enrollmentTaskName='fixture';$script:taskState='Running';$script:taskEnabled=$false
function Get-ScheduledTask { @{State=$script:taskState;Settings=@{Enabled=$script:taskEnabled}} }
function Listeners { $script:ports }
function Get-CimInstance { $script:live }
function Assert-LocalPackageSources {}
# 启动身份由 deploy-owner-repair.test.ps1 独立覆盖；此处仅隔离封存修复状态门禁。
function Assert-ScheduledWebStart {}
function Run-Node([string[]]$Arguments){
 $script:commands+=,$Arguments
 switch($Arguments[1]){'maintenance' {$state|ConvertTo-Json -Depth 10} 'verify' {'{"verified":true}'} 'package' {'{"verified":true}'} default {throw '不得访问备份或执行维护写入'}}
}
$proof=Test-StoppedRepair
if(-not $proof.history.verified -or $proof.backup -or @($script:commands|Where-Object {$_[1]-eq 'package' -and $_[2]-eq $retainedObserverPackage}).Count-ne 1){throw '须回查历史及原Observer，不能访问备份'}
$script:taskEnabled=$true;$rejected=$false
try{Test-StoppedRepair}catch{$rejected=$_.Exception.Message-eq '离线修复自启状态与原启动记录不一致'}
if(-not $rejected){throw '自启重新启用时不得进入离线安装'}
$record|Add-Member -NotePropertyName launchMethod -NotePropertyValue 'scheduled-task'
$proof=Test-StoppedRepair
if(-not $proof.history.verified){throw '受管启动合法恢复 enabled 后失败必须允许同许可续修'}
$script:taskEnabled=$false;$rejected=$false
try{Test-StoppedRepair}catch{$rejected=$_.Exception.Message-eq '离线修复自启状态与原启动记录不一致'}
if(-not $rejected){throw 'scheduled 记录的 enabled 状态漂移必须拒绝'}
$record.PSObject.Properties.Remove('launchMethod')
$script:taskState='Running';$script:taskEnabled=$false
foreach($liveCase in @(@{ports=@(3080);live=@()},@{ports=@();live=@([pscustomobject]@{ProcessId=123})},@{ports=@();live=@([pscustomobject]@{ProcessId=456})})){
 $script:ports=$liveCase.ports;$script:live=$liveCase.live;$rejected=$false
 try{Test-StoppedRepair}catch{$rejected=$true};if(-not $rejected){throw '监听或原进程存活必须拒绝'}
}
$script:ports=@();$script:live=@()
Add-Content -LiteralPath $retainedObserverPackage 'drift'
$rejected=$false;try{Test-StoppedRepair}catch{$rejected=$true};if(-not $rejected){throw '原Observer漂移必须拒绝'}
Write-Output 'PASS 8/8: 实际预检允许受管启动失败后续修且拒绝状态漂移；回查历史/原Observer且不访问备份；自启/端口/旧PID/launcher/Observer漂移拒绝'
$RepairStoppedLaunch=Join-Path $origin 'launch.json';$record|ConvertTo-Json|Set-Content -LiteralPath $RepairStoppedLaunch
$evidenceHashes[$RepairStoppedLaunch]=(Get-FileHash -LiteralPath $RepairStoppedLaunch).Hash
$inputHashes=@{$Package=$ExpectedPackageSha256};$launch=@{Id=789;StartTime=Get-Date}
$launchAssignment=$ast.Find({param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text-eq '$launchRecord' -and $node.Extent.Text.Contains('repairOfLaunch=')},$true)
Invoke-Expression $launchAssignment.Extent.Text
$controlBranch=$ast.Find({param($node) $node -is [System.Management.Automation.Language.IfStatementAst] -and $node.Clauses[0].Item1.Extent.Text-eq '$noBackupRepair' -and $node.Extent.Text.Contains('$newControlPath=')},$true)
Invoke-Expression $controlBranch.Extent.Text
Assert-DeploymentControlRecord $launchRecord
if($launchRecord.backupCreated-ne $false -or -not $launchRecord.enrollmentAutostartRestore -or $launchRecord.retainedObserverPackage-ne $retainedObserverPackage -or $launchRecord.observerPackage){throw '新launch必须保留无备份/自启/原Observer且不安装Observer'}
$enrollmentTaskName='fixture';$script:taskState='Running';$script:taskEnabled=$false;$script:enabled=0
function Get-ScheduledTask { @{State=$script:taskState;Settings=@{Enabled=$script:taskEnabled}} }
function Enable-ScheduledTask { $script:enabled++;$script:taskEnabled=$true }
Restore-EnrollmentAutostart $launchRecord
Restore-EnrollmentAutostart $launchRecord
if($script:enabled-ne 1){throw '精确包修复必须幂等恢复原自启'}
Add-Content -LiteralPath $RepairStoppedLaunch ' '
$rejected=$false;try{Assert-DeploymentControlRecord $launchRecord}catch{$rejected=$true};if(-not $rejected){throw '修复readback须拒绝原证据漂移'}
Write-Output 'PASS 3/3: 实际launch/control生成保留原身份与自启；恢复幂等；原证据漂移在readback拒绝'

# 原备份路径也必须允许本流程已合法恢复自启后的精确包续修；旧记录不能扩大权限。
$backupLaunch=$record|ConvertTo-Json|ConvertFrom-Json -AsHashtable
$backupLaunch.backupCreated=$true;$backupLaunch.backup=$fixture;$backupLaunch.launchMethod='scheduled-task'
$backupIdentity=@{backup=$fixture;oldPid=123;packageSha256='old-package'}
Assert-StoppedRepairPermit $backupLaunch $sealed $before $backupIdentity $state
$backupLaunch.launchMethod='';$rejected=$false
try{Assert-StoppedRepairPermit $backupLaunch $sealed $before $backupIdentity $state}catch{$rejected=$true}
if(-not $rejected){throw '历史备份记录不能新增自启恢复许可'}
$backupLaunch.launchMethod='scheduled-task';$backupLaunch.executionEventsIndexMigrationSha256='migration';$rejected=$false
try{Assert-StoppedRepairPermit $backupLaunch $sealed $before $backupIdentity $state}catch{$rejected=$true}
if(-not $rejected){throw '受管启动不能放宽原迁移修复限制'}
Write-Output 'PASS 3/3: 备份部署受管恢复允许；旧记录及迁移范围保持拒绝'