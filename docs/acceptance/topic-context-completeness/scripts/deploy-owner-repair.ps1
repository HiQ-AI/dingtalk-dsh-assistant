param(
  [switch]$Check,
  [switch]$Readback,
  [switch]$Resume,
  [switch]$Bootstrap,
  [switch]$HoldMaintenance,
  [string]$ContinueMaintenanceId,
  [Nullable[int]]$ExpectedMaintenanceRevision,
  [ValidateRange(1,600)][int]$WaitSeconds=300,
  [Parameter(Mandatory)][string]$Package,
  [Parameter(Mandatory)][string]$Bundle,
  [Parameter(Mandatory)][string]$MergePolicy,
  [Parameter(Mandatory)][string]$ChecksProposal,
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
foreach($path in @($Package,$Bundle,$MergePolicy,$ChecksProposal)) {
 if(-not [IO.Path]::IsPathFullyQualified($path) -or -not(Test-Path -LiteralPath $path -PathType Leaf)){throw '输入文件须为存在的绝对路径'}
}
if(-not [IO.Path]::IsPathFullyQualified($EvidenceDirectory) -or ((Test-Path -LiteralPath $EvidenceDirectory) -and -not ($Readback -or $Resume))){throw '证据目录须为新的绝对路径'}
if(-not $EvidenceDirectory.Replace('\','/').StartsWith("$workspace/docs/tmp/",[StringComparison]::OrdinalIgnoreCase)){throw '证据目录必须在本工作区docs/tmp内'}
if(-not(Test-Path -LiteralPath $tempDirectory -PathType Container)){throw 'D盘TEMP目录不存在'}
function Run-Node([string[]]$Arguments){
 $result=& $node @Arguments
 if($LASTEXITCODE){throw 'Node命令失败，停止部署'}
 return ($result -join "`n")
}
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
 if((Get-FileHash -LiteralPath $Package).Hash.ToLowerInvariant()-ne $ExpectedPackageSha256.ToLowerInvariant()){throw 'package SHA不匹配'}
 if((Get-FileHash -LiteralPath "$profile/cordis.patch.yml").Hash.ToLowerInvariant()-ne $ExpectedProfileSha256.ToLowerInvariant()){throw 'profile CAS不匹配'}
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
 if($ExpectedPackageSha256-ne $launchRecord.packageSha256 -or $ExpectedProfileSha256-ne $launchRecord.sourceProfileSha256){throw '接续参数与原部署输入不一致'}
 if((Get-FileHash -LiteralPath $Package).Hash-ne $launchRecord.packageSha256){throw '接续部署包摘要不匹配'}
 foreach($path in @($Bundle,$MergePolicy,$ChecksProposal)){
  if($path-notin $launchRecord.inputPaths -or (Get-FileHash -LiteralPath $path).Hash-ne $launchRecord.inputHashes.$path){throw '接续配置输入漂移'}
 }
}
function Resume-Deployment($result,$launchRecord) {
 if(-not $result.ready){return $result}
 $state=Invoke-RestMethod http://127.0.0.1:18998/runtime/maintenance -NoProxy -TimeoutSec 20
 if($state.maintenanceId-ne $launchRecord.maintenanceId){throw '维护许可身份不匹配'}
 if($state.active){
  if(-not $state.resumePermitted){throw '当前实例不具备封存许可恢复资格'}
  [void](Change-MaintenancePhase $state 'resume' $launchRecord.maintenanceId)
 }
 $after=Invoke-RestMethod http://127.0.0.1:18998/runtime/maintenance -NoProxy -TimeoutSec 20
 if($after.active -or $after.maintenanceId-ne $launchRecord.maintenanceId){throw '恢复派发回读失败'}
 $result.maintenance=$after;$result.dispatchResumed=$true
 return $result
}
function Read-Deployment($launchRecord) {
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
 foreach($id in $snapshot.tasks){if($ids-notcontains $id){throw '在线Task身份缺失'}}
 $history=Run-Node @($checker,'verify',"$EvidenceDirectory/control-before.json")|ConvertFrom-Json
 $packageReadback=Run-Node @($checker,'package',$Package,$source,$installed)|ConvertFrom-Json
 $webProof=Run-Node @($checker,'web',"$EvidenceDirectory/start.stdout.log")|ConvertFrom-Json
 $maintenance=Invoke-RestMethod http://127.0.0.1:18998/runtime/maintenance -NoProxy -TimeoutSec 20
 if($maintenance.maintenanceId-ne $launchRecord.maintenanceId){throw '启动后维护许可漂移'}
 return @{status='ready';ready=$true;pid=$fresh.ProcessId;launcherPid=$launchRecord.launcherPid;tasks=$tasks.Count;history=$history;package=$packageReadback;web=$webProof;maintenance=$maintenance;dispatchResumed=(-not $maintenance.active);logs=@($logs);scheduledTaskChanged=$false;businessAcceptancePassed=$false}
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
if(($ContinueMaintenanceId -and $null-eq $ExpectedMaintenanceRevision) -or
   (-not $ContinueMaintenanceId -and $null-ne $ExpectedMaintenanceRevision) -or
   ($Bootstrap -and ($ContinueMaintenanceId -or $HoldMaintenance))){throw '维护接续须同时提供ID与revision，且不能用于Bootstrap'}
# 留出备份实际体积、安装扩展及至少1GiB余量；不足时停止，不清理任何文件。
$backupBytes=(@(Get-ChildItem -LiteralPath $domain,"$runtime/artifacts" -File -Recurse)+@(Get-ChildItem -LiteralPath $runtime,$profile -File)|Measure-Object Length -Sum).Sum
$requiredBytes=[long]$backupBytes+([long](Get-Item -LiteralPath $Package).Length*10)+1GB
$freeBytes=(Get-PSDrive D).Free
if($freeBytes-lt $requiredBytes){throw "D盘空间不足：可用 $freeBytes，所需 $requiredBytes"}
$inputHashes=@{}
foreach($path in @($Package,$Bundle,$MergePolicy,$ChecksProposal)){$inputHashes[$path]=(Get-FileHash -LiteralPath $path).Hash}
$packageProof=Run-Node @($checker,'package',$Package,$source)
$configArgs=@("$workspace/scripts/configure-project-local-acceptance.mjs",'--profile',"$profile/cordis.patch.yml",'--bundle',$Bundle,'--merge-policy',$MergePolicy,'--checks-proposal',$ChecksProposal,'--expected-sha256',$ExpectedProfileSha256)
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
if($Check){@{mode='check';writes=0;online=[bool]$old;disk=@{freeBytes=$freeBytes;requiredBytes=$requiredBytes;backupBytes=$backupBytes};package=($packageProof|ConvertFrom-Json);tasks=($snapshot|ConvertFrom-Json).tasks.Count}|ConvertTo-Json -Depth 4;exit 0}
# 只有所有预检通过后才开始写证据和停止精确已核实进程。
New-Item -ItemType Directory -Path $EvidenceDirectory|Out-Null
$maintenanceId=if($ContinueMaintenanceId){$ContinueMaintenanceId}else{'deploy-'+[guid]::NewGuid().ToString()}
$lockProcess=$null
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
$backup='D:/dsh_home/backups/owner-repair-'+(Get-Date -Format yyyyMMdd-HHmmss-fff)
New-Item -ItemType Directory -Path $backup,"$backup/runtime","$backup/profile"|Out-Null
Copy-Item -LiteralPath $domain -Destination "$backup/domain" -Recurse
Get-ChildItem -LiteralPath $runtime -File|Copy-Item -Destination "$backup/runtime"
Copy-Item -LiteralPath "$runtime/artifacts" -Destination "$backup/runtime/artifacts" -Recurse
foreach($name in @('cordis.patch.yml','cordis.yml','package.json','package-lock.json','settings.yaml','pnpm-lock.yaml')){if(Test-Path -LiteralPath "$profile/$name"){Copy-Item -LiteralPath "$profile/$name" -Destination "$backup/profile/$name";Same-Hash "$profile/$name" "$backup/profile/$name"}}
Same-Hash "$runtime/control.sqlite" "$backup/runtime/control.sqlite"
Same-Hash "$domain/dingtalk_dsh_assistant.json" "$backup/domain/dingtalk_dsh_assistant.json"
$backupProof=Run-Node @($checker,'backup-verify',$backup)
$backupProof|Set-Content -LiteralPath "$backup/manifest.json" -Encoding utf8
@{backup=$backup;oldPid=$old.ProcessId;packageSha256=(Get-FileHash -LiteralPath $Package).Hash}|ConvertTo-Json|Set-Content "$EvidenceDirectory/backup.json"
$env:DSH_HOME='D:/dsh_home';$env:TEMP=$tempDirectory;$env:TMP=$tempDirectory
foreach($path in $inputHashes.Keys){if((Get-FileHash -LiteralPath $path).Hash-ne $inputHashes[$path]){throw '部署输入文件已变化'}}
if($lockProcess.HasExited){throw '安装前独占锁已丢失'}
& $node "$profile/node_modules/@deepseek-ai/dsh/lib/bin.js" plugin --profile web add $Package *> "$EvidenceDirectory/install.log"
if($LASTEXITCODE){throw '安装失败，保持停机并保留备份'}
Run-Node ($configArgs+@('--apply'))|Set-Content "$EvidenceDirectory/config-applied.json"
Run-Node @($checker,'package',$Package,$source,$installed)|Set-Content "$EvidenceDirectory/installed.json"
} finally {
 if($lockProcess){
 $lockProcess.StandardInput.Close()
 if(-not $lockProcess.WaitForExit(10000)){throw '离线独占锁尚未释放，禁止启动'}
 $lockProcess.Dispose()
 }
}
if($Bootstrap){
 if(@(Listeners).Count -or (Get-CimInstance Win32_Process -Filter "ProcessId=$($old.ProcessId)" -ErrorAction SilentlyContinue)){throw '离线维护前发现旧实例'}
 $disabledHash=(Get-FileHash -LiteralPath "$profile/cordis.patch.yml").Hash.ToLowerInvariant()
 Run-Node @($bootstrapTool,'seal-offline','--profile',"$profile/cordis.patch.yml",'--expected-sha256',$disabledHash,'--installed',$installed,'--maintenance-id',$maintenanceId)|Set-Content "$EvidenceDirectory/bootstrap-maintenance-sealed.json"
 Run-Node @($bootstrapTool,'enable','--profile',"$profile/cordis.patch.yml",'--expected-sha256',$disabledHash)|Set-Content "$EvidenceDirectory/bootstrap-enabled.json"
}
# 用既有启动脚本，不创建或改写计划任务；仅当前进程树使用D盘TEMP。
$env:PATH=(Split-Path -Parent $node)+';'+$env:PATH
$launch=Start-Process -FilePath 'pwsh.exe' -ArgumentList @('-NoProfile','-File',$starter) -WindowStyle Hidden -PassThru -RedirectStandardOutput "$EvidenceDirectory/start.stdout.log" -RedirectStandardError "$EvidenceDirectory/start.stderr.log"
$launchRecord=@{mode=if($Bootstrap){'bootstrap'}else{'maintenance'};launcherPid=$launch.Id;startedAt=$launch.StartTime.ToUniversalTime().ToString('o');packageSha256=(Get-FileHash -LiteralPath $Package).Hash;sourceProfileSha256=$ExpectedProfileSha256;inputPaths=@($Bundle,$MergePolicy,$ChecksProposal);inputHashes=$inputHashes;profileSha256=(Get-FileHash -LiteralPath "$profile/cordis.patch.yml").Hash;backup=$backup;maintenanceId=$maintenanceId}
$launchRecord|ConvertTo-Json|Set-Content -LiteralPath "$EvidenceDirectory/launch.json" -Encoding utf8
$result=Read-Deployment $launchRecord
if($result.ready -and -not $HoldMaintenance){$result=Resume-Deployment $result $launchRecord}
$result|ConvertTo-Json -Depth 10|Set-Content -LiteralPath "$EvidenceDirectory/readback.json" -Encoding utf8
$result|ConvertTo-Json -Depth 10
