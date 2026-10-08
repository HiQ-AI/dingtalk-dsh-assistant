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
  $result=Invoke-CoreStage 'check' $preflight
  if($null-eq $result.writes -or $result.writes-ne 0){throw 'DEPLOY_CHECK_NOT_READONLY'}
  if(-not $Check){
   $stage='deploy';$install=$a.Clone();$install.HoldMaintenance=$true
   $result=Invoke-CoreStage $stage $install
   $stage='readback';$next=$a.Clone();$next.Readback=$true
   $result=Invoke-CoreStage $stage $next
   if(-not $result.ready){throw 'DEPLOY_READBACK_NOT_READY'}
   $stage='resume';$next=$a.Clone();$next.Resume=$true
   $result=Invoke-CoreStage $stage $next
   if(-not $result.ready -or -not $result.dispatchResumed){throw 'DEPLOY_RESUME_NOT_CONFIRMED'}
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
