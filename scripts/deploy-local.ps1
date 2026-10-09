param(
 [Parameter(Mandatory)][string]$ArgumentsFile,
 [switch]$Check,
 [switch]$Readback,
 [switch]$Resume
)
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$core=Join-Path $workspace 'docs/acceptance/topic-context-completeness/scripts/deploy-owner-repair.ps1'
$profile='D:/dsh_home/profiles/web/cordis.patch.yml'
if(@($Check,$Readback,$Resume|Where-Object {$_}).Count-gt 1){throw 'DEPLOY_MODE_CONFLICT'}
if(-not [IO.Path]::IsPathFullyQualified($ArgumentsFile)){throw 'DEPLOY_ARGUMENTS_PATH_REQUIRED'}
$a=Get-Content -LiteralPath $ArgumentsFile -Raw|ConvertFrom-Json -AsHashtable
if($a-isnot [hashtable]){throw 'DEPLOY_ARGUMENTS_INVALID'}
$tokens=$null;$parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($core,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'DEPLOY_CORE_INVALID'}
$allowed=@($ast.ParamBlock.Parameters.Name.VariablePath.UserPath)
foreach($key in $a.Keys){if($key-notin $allowed -or $key-in @('Check','Readback','Resume')){throw 'DEPLOY_ARGUMENT_UNKNOWN'}}
if(-not $a.Package -or -not [IO.Path]::IsPathFullyQualified($a.Package)){throw 'DEPLOY_PACKAGE_REQUIRED'}
if(-not $a.EvidenceDirectory){$a.EvidenceDirectory=Join-Path $workspace ('docs/tmp/local-deployment-'+(Get-Date -Format yyyyMMdd-HHmmss-fff))}
$evidence=[IO.Path]::GetFullPath($a.EvidenceDirectory)
$docsRoot=[IO.Path]::GetFullPath((Join-Path $workspace 'docs/tmp'))+[IO.Path]::DirectorySeparatorChar
if(-not $evidence.StartsWith($docsRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'DEPLOY_EVIDENCE_OUTSIDE_DOCS'}
$a.EvidenceDirectory=$evidence
if($Readback -or $Resume){
 $launch=Get-Content -LiteralPath (Join-Path $evidence 'launch.json') -Raw|ConvertFrom-Json
 $a.ExpectedProfileSha256=$launch.sourceProfileSha256
 $a.ExpectedPackageSha256=$launch.packageSha256
 if($a.ObserverPackage){$a.ExpectedObserverPackageSha256=$launch.observerPackageSha256}
}else{
 $a.ExpectedProfileSha256=(Get-FileHash -LiteralPath $profile -Algorithm SHA256).Hash.ToLowerInvariant()
 $a.ExpectedPackageSha256=(Get-FileHash -LiteralPath $a.Package -Algorithm SHA256).Hash.ToLowerInvariant()
 if($a.ObserverPackage){$a.ExpectedObserverPackageSha256=(Get-FileHash -LiteralPath $a.ObserverPackage -Algorithm SHA256).Hash.ToLowerInvariant()}
}
function Invoke-CoreStage([string]$stage,[hashtable]$values){
 Write-Host "部署阶段：$stage"
 $psi=[Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
 $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $psi.StandardOutputEncoding=[Text.UTF8Encoding]::new($false);$psi.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
 foreach($v in @('-NoProfile','-NonInteractive','-File',$core)){$psi.ArgumentList.Add($v)}
 foreach($key in ($values.Keys|Sort-Object)){
  $value=$values[$key]
  if($null-eq $value -or $value-eq ''){continue}
  if($value-is [bool]){if($value){$psi.ArgumentList.Add('-'+$key)};continue}
  $psi.ArgumentList.Add('-'+$key);$psi.ArgumentList.Add([string]$value)
 }
 $p=[Diagnostics.Process]::Start($psi)
 $outTask=$p.StandardOutput.ReadToEndAsync();$errTask=$p.StandardError.ReadToEndAsync()
 $p.WaitForExit();$stdout=$outTask.GetAwaiter().GetResult();$stderr=$errTask.GetAwaiter().GetResult();$code=$p.ExitCode;$p.Dispose()
 if(-not $Check){
  [IO.File]::WriteAllText((Join-Path $logDirectory "$stage.stdout.log"),$stdout)
  [IO.File]::WriteAllText((Join-Path $logDirectory "$stage.stderr.log"),$stderr)
 }
 if($code-ne 0){
  $clean=[regex]::Replace($stderr,'\x1b\[[0-9;]*[A-Za-z]','')
  $native=[regex]::Match($clean,'Error:\s*([A-Z][A-Z0-9_]{5,})')
  $script:coreReason=if($native.Success){$native.Groups[1].Value}else{
   $known=[regex]::Matches([IO.File]::ReadAllText($core),"throw\s+'([^'\r\n]+)'")
   @($known|ForEach-Object {$_.Groups[1].Value}|Where-Object {$clean.Contains($_)})|Select-Object -Last 1
  }
  throw "DEPLOY_STAGE_FAILED:$stage`:exit=$code"
 }
 try{$result=$stdout|ConvertFrom-Json}catch{throw "DEPLOY_STAGE_RESULT_INVALID:$stage"}
 return $result
}
function Invoke-VerificationDrainRecovery {
 $helper=Join-Path $workspace 'docs/acceptance/topic-context-completeness/scripts/recover-verification-drain.mjs'
 $bridge=Join-Path $workspace 'docs/acceptance/topic-context-completeness/scripts/recover-quarantined-echo.ps1'
 $nativeNode='D:/soft/node-v24.19.0/node.exe'
 $manifest=Join-Path ($evidence+'-runner') 'verification-drain-manifest.json'
 $recoveryDirectory=$evidence+'-verification-drain'
 $raw=& $nativeNode $helper preview $manifest $a.Package $a.ExpectedPackageSha256
 if($LASTEXITCODE){throw 'DEPLOY_DRAIN_PREVIEW_REJECTED'}
 $preview=($raw-join "`n")|ConvertFrom-Json
 if($preview.eligibleRecovery-eq$false-and$preview.writes-eq0){return $preview}
 if(-not$preview.eligibleRecovery-or$preview.writes-ne0-or$preview.profileSha256-ne$a.ExpectedProfileSha256){throw 'DEPLOY_DRAIN_PREVIEW_INVALID'}
 $state=Invoke-RestMethod http://127.0.0.1:18998/runtime/maintenance -NoProxy -TimeoutSec 15
 if($state.revision-ne$preview.maintenanceRevision-or$state.maintenanceId-ne$preview.maintenanceId){throw 'DEPLOY_DRAIN_MAINTENANCE_CHANGED'}
 if($state.active-and($a.ContinueMaintenanceId-ne$state.maintenanceId-or$a.ExpectedMaintenanceRevision-ne$state.revision)){throw 'DEPLOY_DRAIN_CONTINUATION_REQUIRED'}
 if($Check){return $preview}
 if(-not$state.active){
  $id='deploy-drain-'+[guid]::NewGuid().ToString()
  $body=@{requestId=$id;active=$true;expectedRevision=$state.revision;maintenanceId=$id;reason='受控部署：原检查进程已退出，仅核验并排空原节点'}|ConvertTo-Json
  $null=Invoke-RestMethod http://127.0.0.1:18998/runtime/maintenance -Method Post -ContentType 'application/json' -Headers @{Origin='http://127.0.0.1:3080'} -Body $body -NoProxy -TimeoutSec 20
 }
 $raw=& $nativeNode $helper capture $manifest $a.Package $a.ExpectedPackageSha256
 if($LASTEXITCODE){throw 'DEPLOY_DRAIN_CAPTURE_REJECTED'}
 $raw=& $bridge -Scope verification -IncidentManifest $manifest -ExpectedProfileSha256 $a.ExpectedProfileSha256 -EvidenceDirectory $recoveryDirectory -Check
 if(-not$?){throw 'DEPLOY_DRAIN_CHECK_REJECTED'}
 $raw=& $bridge -Scope verification -IncidentManifest $manifest -ExpectedProfileSha256 $a.ExpectedProfileSha256 -EvidenceDirectory $recoveryDirectory
 if(-not$?){throw 'DEPLOY_DRAIN_RECOVERY_REJECTED'}
 $recovered=($raw-join "`n")|ConvertFrom-Json
 $state=Invoke-RestMethod http://127.0.0.1:18998/runtime/maintenance -NoProxy -TimeoutSec 15
 if(-not$state.drained-or-not$state.active-or$state.phase-ne'draining'-or$state.maintenanceId-ne$recovered.ContinueMaintenanceId-or$state.revision-ne$recovered.ExpectedMaintenanceRevision-or(Get-FileHash -LiteralPath $profile).Hash.ToLowerInvariant()-ne$a.ExpectedProfileSha256){throw 'DEPLOY_DRAIN_READBACK_CHANGED'}
 $a.ContinueMaintenanceId=$state.maintenanceId;$a.ExpectedMaintenanceRevision=$state.revision
 return $recovered
}
$stage='check';$logDirectory=$evidence+'-runner'
try{
 if(-not $Check){
  if(-not(Test-Path -LiteralPath $logDirectory)){[void](New-Item -ItemType Directory -Path $logDirectory)}
  $a|ConvertTo-Json -Depth 20|Set-Content -LiteralPath (Join-Path $logDirectory 'arguments.json')
 }
 if($Readback -or $Resume){
  $stage=if($Resume){'resume'}else{'readback'};$next=$a.Clone();$next[$stage]=$true
  $result=Invoke-CoreStage $stage $next
  if($Resume -and (-not $result.ready -or -not $result.dispatchResumed)){throw 'DEPLOY_RESUME_NOT_CONFIRMED'}
  if($Readback -and -not $result.ready){throw 'DEPLOY_READBACK_NOT_READY'}
 }else{
  $preflight=$a.Clone();$preflight.Check=$true
  try{$result=Invoke-CoreStage 'check' $preflight}catch{
   if($script:coreReason-notlike 'DEPLOY_NOT_DRAINED*'-and$script:coreReason-ne'接续维护许可身份、版本或排空状态不匹配'){throw}
   $stage='verification-drain';$recovery=Invoke-VerificationDrainRecovery
   if($recovery.eligibleRecovery-eq$false){$stage='check';throw}
   if($Check){@{ok=$true;checkOnly=$true;writes=0;eligibleRecovery=$true;needsMaintenance=$recovery.needsMaintenance;coreCheckComplete=$false;ready=$false;dispatchResumed=$false;packageSha256=$a.ExpectedPackageSha256;action='正式执行时先受管排空，再重新完整Check与部署'}|ConvertTo-Json;exit 0}
   $preflight=$a.Clone();$preflight.Check=$true;$stage='check';$result=Invoke-CoreStage 'check' $preflight
  }
  if($null-eq $result.writes -or $result.writes-ne 0){throw 'DEPLOY_CHECK_NOT_READONLY'}
  if(-not $Check){
   $stage='deploy';$install=$a.Clone();$install.HoldMaintenance=$true
   $result=Invoke-CoreStage $stage $install
   $stage='readback';$next=$a.Clone();$next.Readback=$true
   $result=Invoke-CoreStage $stage $next
   if(-not $result.ready){throw 'DEPLOY_READBACK_NOT_READY'}
   if(-not $a.HoldMaintenance){
    $stage='resume';$next=$a.Clone();$next.Resume=$true
    $result=Invoke-CoreStage $stage $next
    if(-not $result.ready -or -not $result.dispatchResumed){throw 'DEPLOY_RESUME_NOT_CONFIRMED'}
   }
  }
 }
 $summary=@{ok=$true;stage=$stage;checkOnly=[bool]$Check;writes=if($Check){0}else{$null};evidenceDirectory=$evidence;ready=$result.ready;dispatchResumed=$result.dispatchResumed;packageSha256=$a.ExpectedPackageSha256}
 if(-not $Check){$summary|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $logDirectory 'summary.json')}
 $summary|ConvertTo-Json
}catch{
 $summary=@{ok=$false;stage=$stage;code=if($_.Exception.Message-match '^DEPLOY_[A-Z_]+(?::[a-z]+:exit=\d+)?$'){$_.Exception.Message}else{'DEPLOY_STAGE_EXCEPTION'};reason=$script:coreReason;evidenceDirectory=$evidence;logs=if($Check){$null}else{$logDirectory};dispatchResumed=$false;action='停止；按原收据Readback/Resume或正式失败恢复，不自动重装重启'}
 if(-not $Check -and (Test-Path -LiteralPath $logDirectory)){$summary|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $logDirectory 'summary.json')}
 $summary|ConvertTo-Json
 exit 1
}
