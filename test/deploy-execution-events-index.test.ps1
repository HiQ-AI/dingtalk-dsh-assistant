$ErrorActionPreference='Stop'
$errors=$null;$tokens=$null
$helper=Join-Path $PSScriptRoot '../docs/acceptance/topic-context-completeness/scripts/deploy-owner-repair.ps1'
$ast=[System.Management.Automation.Language.Parser]::ParseFile($helper,[ref]$tokens,[ref]$errors)
if($errors.Count){throw '脚本解析失败'}
foreach($name in @('Assert-DeploymentMode','Assert-ExecutionEventsIndexReadback')){
 $function=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name-eq $name},$true)
 Invoke-Expression $function.Extent.Text
}
$MigrateExecutionEventsIndex=$true;$MigrateMessageImpact=$false;$Bootstrap=$false;$RepairStoppedLaunch='';$TaskMigrationPlan=''
$DirectQueriesProposal='proposal';$Bundle='';$MergePolicy='';$ChecksProposal='';$ObserverPackage='';$ExpectedObserverPackageSha256=''
Assert-DeploymentMode
foreach($name in @('Bootstrap','RepairStoppedLaunch','MigrateMessageImpact','TaskMigrationPlan')){
 Set-Variable -Name $name -Value $(if($name-in @('RepairStoppedLaunch','TaskMigrationPlan')){'fixture'}else{$true})
 $rejected=$false;try{Assert-DeploymentMode}catch{$rejected=$true}
 if(-not $rejected){throw "迁移模式必须拒绝$name"}
 Set-Variable -Name $name -Value $(if($name-in @('RepairStoppedLaunch','TaskMigrationPlan')){''}else{$false})
}
Write-Output 'PASS 5/5: 仅独立维护索引迁移；四类互斥组合拒绝'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).Replace('\','/')
$EvidenceDirectory=Join-Path $workspace ('docs/tmp/event-index-deploy-fixture-'+[guid]::NewGuid())
$backup=Join-Path $EvidenceDirectory 'backup'
New-Item -ItemType Directory -Path $backup -Force|Out-Null
try {
 $manifest=Join-Path $backup 'manifest.json'; '{}'|Set-Content -LiteralPath $manifest
 $receipt=Join-Path $EvidenceDirectory 'execution-events-index-migration.json'
 $proof=@{verified=$true;version=8;indexName='execution_events_kind_seq';baseline=@{};
  migrationToolSha256=(Get-FileHash -LiteralPath "$workspace/scripts/migrate-execution-events-index.mjs").Hash;
  backupManifestSha256=(Get-FileHash -LiteralPath $manifest).Hash}
 $proof|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $receipt
 $record=@{executionEventsIndexMigrationSha256=(Get-FileHash -LiteralPath $receipt).Hash;backup=$backup}
 $checker='fixture-checker';$script:reads=0
 function Run-Node([string[]]$Arguments){
  if(($Arguments -join '|')-ne "$checker|execution-events-index-verify|$receipt"){throw '在线读取只能校验结构，不得重比迁移瞬间全表'}
  $script:reads++;return '{"verified":true,"version":8}'
 }
 if(-not(Assert-ExecutionEventsIndexReadback $record).verified){throw '只读迁移回读失败'}
 foreach($case in @('mode','receipt','tool','backup')){
  $copy=$record.Clone();$savedProof=$proof.Clone()
  switch($case){
   'mode'{$MigrateExecutionEventsIndex=$false}
   'receipt'{$copy.executionEventsIndexMigrationSha256='bad'}
   'tool'{$savedProof.migrationToolSha256='bad';$savedProof|ConvertTo-Json -Depth 10|Set-Content $receipt;$copy.executionEventsIndexMigrationSha256=(Get-FileHash $receipt).Hash}
   'backup'{$savedProof.backupManifestSha256='bad';$savedProof|ConvertTo-Json -Depth 10|Set-Content $receipt;$copy.executionEventsIndexMigrationSha256=(Get-FileHash $receipt).Hash}
  }
  $rejected=$false;try{Assert-ExecutionEventsIndexReadback $copy}catch{$rejected=$true}
  if(-not $rejected){throw "迁移回读必须拒绝$case 漂移"}
  $MigrateExecutionEventsIndex=$true;$proof|ConvertTo-Json -Depth 10|Set-Content $receipt
 }
 if($script:reads-ne 1){throw '拒绝路径不得调用结构读取'}
 Write-Output 'PASS 5/5: 在线只读结构复核；模式/回执/工具/备份绑定漂移拒绝'
 $text=[IO.File]::ReadAllText($helper)
 if($text.IndexOf('$executionEventsIndexMigrationSha256=Invoke-ExecutionEventsIndexMigration')-le $text.IndexOf('$backupProof=Run-Node @($checker,''backup-verify''')){throw '迁移必须在完整备份后'}
 if($text.IndexOf('executionEventsIndexMigrationSha256=$executionEventsIndexMigrationSha256')-lt 0){throw 'Launch必须持久绑定迁移回执'}
 if(-not $text.Contains('if(-not $Bootstrap){') -or -not $text.Contains('Disable-ScheduledTask -TaskName $enrollmentTaskName')){throw '维护部署必须纳入自启封存生命周期'}
 if(-not $text.Contains('if($Check -and $MigrateExecutionEventsIndex){$eventsIndexCheck=Run-Node')){throw '部署Check必须实跑零写迁移预检'}
 if($text.LastIndexOf("'execution-events-index-verify'")-gt $text.LastIndexOf('$launch=Start-DeployedWeb')){throw '全表复核必须在启动前完成'}
 Write-Output 'PASS 5/5: 备份后执行、Launch绑定、自启封存、Check实跑、启动前全表复核'
}finally{
 $resolved=[IO.Path]::GetFullPath($EvidenceDirectory)
 if(-not $resolved.StartsWith([IO.Path]::GetFullPath((Join-Path $workspace 'docs/tmp/')),[StringComparison]::OrdinalIgnoreCase)){throw '清理目录越界'}
 Remove-Item -LiteralPath $resolved -Recurse -Force
}
