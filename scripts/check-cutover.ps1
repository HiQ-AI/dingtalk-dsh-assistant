[CmdletBinding()]
param(
    [switch]$Check,
    [string]$TargetGroupId,
    [string]$DwsProfile
)

$ErrorActionPreference = 'Stop'
if (-not $Check) {
    throw 'This script is read-only and must be invoked with -Check.'
}

function Get-ListenerProcess([int]$Port) {
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $connection) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)"
    return [ordered]@{ port = $Port; pid = $process.ProcessId; parentPid = $process.ParentProcessId; name = $process.Name; commandLine = $process.CommandLine }
}

$dwsConsumers = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'dws.exe' -and $_.CommandLine -match '\bevent\s+(?:\+listen-im|consume)\b'
})
$discoveredGroups = @($dwsConsumers | ForEach-Object {
    if ($_.CommandLine -match '--(?:chat-id|group)\s+(?<value>\S+)') { $Matches.value }
} | Sort-Object -Unique)
$discoveredProfiles = @($dwsConsumers | ForEach-Object {
    if ($_.CommandLine -match '--profile\s+(?<value>\S+)') { $Matches.value }
} | Sort-Object -Unique)

if ([string]::IsNullOrWhiteSpace($TargetGroupId) -and $discoveredGroups.Count -eq 1) { $TargetGroupId = $discoveredGroups[0] }
if ([string]::IsNullOrWhiteSpace($DwsProfile) -and $discoveredProfiles.Count -eq 1) { $DwsProfile = $discoveredProfiles[0] }

$projectRoot = Split-Path -Parent $PSScriptRoot
$profilePatch = Get-Content -Raw -Encoding UTF8 (Join-Path $projectRoot '.dsh\profiles\resident\cordis.patch.yml')
$dwsDisabled = $profilePatch -match 'dws:\s*\r?\n\s+enabled:\s+false'
$writesDisabled = $profilePatch -match 'writesAuthorized:\s+false'
$approvalDisabled = $profilePatch -match 'approval:\s*\r?\n\s+enabled:\s+false'
$runtimeListener = Get-ListenerProcess 18998
$runtimeHealth = $null
if ($null -ne $runtimeListener) {
    try { $runtimeHealth = Invoke-RestMethod 'http://127.0.0.1:18998/health' -TimeoutSec 3 } catch { $runtimeHealth = [ordered]@{ status = 'unreachable'; error = $_.Exception.Message } }
}

$targetConsumers = @($dwsConsumers | Where-Object { -not [string]::IsNullOrWhiteSpace($TargetGroupId) -and $_.CommandLine -match [regex]::Escape($TargetGroupId) })
$blockers = [System.Collections.Generic.List[string]]::new()
if ([string]::IsNullOrWhiteSpace($TargetGroupId)) { $blockers.Add('target_group_not_unique_or_missing') }
if ([string]::IsNullOrWhiteSpace($DwsProfile)) { $blockers.Add('dws_profile_not_unique_or_missing') }
if ($targetConsumers.Count -gt 0) { $blockers.Add('old_group_consumer_must_stop_before_new_subscription') }
if (-not $dwsDisabled) { $blockers.Add('dws_default_disabled_invariant_failed') }
if (-not $writesDisabled) { $blockers.Add('dws_write_default_disabled_invariant_failed') }
if (-not $approvalDisabled) { $blockers.Add('approval_default_disabled_invariant_failed') }
if ($null -ne $runtimeHealth -and $runtimeHealth.status -eq 'degraded') { $blockers.Add('dsh_runtime_recovery_degraded') }

$result = [ordered]@{
    checkedAt = (Get-Date).ToString('o')
    readOnly = $true
    targetGroupId = $TargetGroupId
    dwsProfile = $DwsProfile
    discoveredGroups = $discoveredGroups
    discoveredProfiles = $discoveredProfiles
    listeners = [ordered]@{ agentStudio = Get-ListenerProcess 8898; codexAppServer = Get-ListenerProcess 8899; dshRuntime = $runtimeListener }
    runtimeHealth = $runtimeHealth
    targetConsumers = @($targetConsumers | ForEach-Object { [ordered]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; commandLine = $_.CommandLine } })
    defaults = [ordered]@{ dwsEnabled = -not $dwsDisabled; writesAuthorized = -not $writesDisabled; approvalEnabled = -not $approvalDisabled }
    blockers = @($blockers)
    ready = $blockers.Count -eq 0
}

$result | ConvertTo-Json -Depth 8
if ($blockers.Count -gt 0) { exit 2 }
