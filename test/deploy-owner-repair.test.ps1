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

foreach($name in @('Change-MaintenancePhase','Resume-Deployment','Assert-LaunchInputs')){
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
