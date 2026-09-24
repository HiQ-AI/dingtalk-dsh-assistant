param(
    [Parameter(Mandatory = $true)][int]$RuntimePid,
    [Parameter(Mandatory = $true)][int]$RuntimePort,
    [Parameter(Mandatory = $true)][string]$ScheduledTaskName
)
$ErrorActionPreference = 'Stop'
if ($RuntimePid -le 0 -or $RuntimePort -le 0 -or $RuntimePort -gt 65535) { throw 'cutover_probe_invalid_target' }
$pidPresent = $null -ne (Get-Process -Id $RuntimePid -ErrorAction SilentlyContinue)
$listenerPresent = @((Get-NetTCPConnection -State Listen -ErrorAction Stop) | Where-Object LocalPort -eq $RuntimePort).Count -gt 0
$scheduled = @(Get-ScheduledTask -ErrorAction Stop | Where-Object TaskName -eq $ScheduledTaskName)
if ($scheduled.Count -gt 1) { throw 'cutover_probe_ambiguous_scheduled_task' }
$autostartDisabled = $scheduled.Count -eq 0 -or [string]$scheduled[0].State -eq 'Disabled'
@{ stopped = (-not $pidPresent -and -not $listenerPresent -and $autostartDisabled); pidPresent = $pidPresent; listenerPresent = $listenerPresent; autostartDisabled = $autostartDisabled; runtimePid = $RuntimePid; runtimePort = $RuntimePort; scheduledTaskName = $ScheduledTaskName; scheduledTaskPresent = ($scheduled.Count -eq 1); observedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
