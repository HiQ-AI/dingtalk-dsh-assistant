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
