param(
    [switch]$Check,
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$restartClock = [Diagnostics.Stopwatch]::StartNew()
$phaseClock = [Diagnostics.Stopwatch]::StartNew()
$timings = [ordered]@{}
$runbook = Join-Path $projectRoot 'docs\ops\resident-review-local-deployment.md'
$startScript = Join-Path $PSScriptRoot 'start-web.ps1'
$logDirectory = Join-Path $projectRoot 'docs\tmp\dsh-web-local'
$userDshHome = [Environment]::GetEnvironmentVariable('DSH_HOME', 'User')
$dshHome = if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
    $env:DSH_HOME
} elseif (-not [string]::IsNullOrWhiteSpace($userDshHome)) {
    $userDshHome
} else {
    Join-Path $env:USERPROFILE '.dsh'
}
$dshEntry = Join-Path $dshHome 'profiles\web\node_modules\@deepseek-ai\dsh\lib\bin.js'
$nodeExe = 'D:\soft\node-v24.19.0\node.exe'
$checker = Join-Path $projectRoot 'docs\acceptance\topic-context-completeness\scripts\check-repair-deployment.mjs'
$maintenanceUri = 'http://127.0.0.1:18998/runtime/maintenance'
$readyState = '已就绪；认证访问和业务验收未验证'

function Get-WebListeners {
    @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
        Where-Object Port -In @(3080, 18998) | Select-Object -ExpandProperty Port -Unique)
}

function Get-WebState([switch]$IncludeAccessUrl) {
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.CommandLine -match '@deepseek-ai\\dsh\\lib\\bin\.js web --no-open' -and
        $_.CommandLine.Contains($dshEntry, [StringComparison]::OrdinalIgnoreCase)
    })
    $connections = if (@(Get-WebListeners).Count) {
        @(Get-CimInstance -Namespace root/StandardCimv2 -Query 'SELECT LocalPort,OwningProcess FROM MSFT_NetTCPConnection WHERE State=2 AND (LocalPort=3080 OR LocalPort=18998)')
    } else { @() }
    $webOwners = @($connections | Where-Object LocalPort -EQ 3080 | Select-Object -ExpandProperty OwningProcess -Unique)
    $runtimeOwners = @($connections | Where-Object LocalPort -EQ 18998 | Select-Object -ExpandProperty OwningProcess -Unique)
    $processId = if ($processes.Count -eq 1) { [int]$processes[0].ProcessId } else { $null }
    $portsOwnedByProcess = $null -ne $processId -and
        $webOwners.Count -eq 1 -and $webOwners[0] -eq $processId -and
        $runtimeOwners.Count -eq 1 -and $runtimeOwners[0] -eq $processId

    $healthStatus = $null
    $recoveryIssueCount = $null
    $anonymousWebStatus = $null
    $accessUrl = $null
    if ($portsOwnedByProcess) {
        $startedAt = [datetime]$processes[0].CreationDate
        $startupLogs = @(
            (Join-Path $env:TEMP 'dsh-web.stdout.log'),
            (Join-Path $logDirectory 'web.log')
        )
        foreach ($logPath in $(if ($IncludeAccessUrl) { $startupLogs } else { @() })) {
            if (-not (Test-Path -LiteralPath $logPath)) { continue }
            $logFile = Get-Item -LiteralPath $logPath
            if ($logFile.LastWriteTime -lt $startedAt) { continue }
            $logContent = Get-Content -LiteralPath $logPath -Raw
            $match = [regex]::Match($logContent, 'http://127\.0\.0\.1:3080/\?token=[^\s"''<>]+')
            if ($match.Success) {
                $accessUrl = $match.Value
                break
            }
        }
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:18998/health' -NoProxy -TimeoutSec 3
            $healthStatus = $health.status
            $recoveryIssueCount = $health.recoveryIssueCount
        }
        catch {
            $healthStatus = '无法读取'
        }
        try {
            $anonymousWebStatus = (Invoke-WebRequest -Uri 'http://127.0.0.1:3080/' -NoProxy -SkipHttpErrorCheck -TimeoutSec 3).StatusCode
        }
        catch {
            $anonymousWebStatus = '无法读取'
        }
    }

    $state = if ($processes.Count -eq 0 -and $webOwners.Count -eq 0 -and $runtimeOwners.Count -eq 0) {
        '已停止'
    } elseif ($portsOwnedByProcess -and $healthStatus -eq 'ok' -and
        $null -ne $recoveryIssueCount -and [int]$recoveryIssueCount -eq 0 -and
        $anonymousWebStatus -eq 401) {
        '已就绪；认证访问和业务验收未验证'
    } else {
        '异常或未就绪'
    }

    [pscustomobject]@{
        State = $state
        ProcessCount = $processes.Count
        ProcessId = $processId
        ProcessStartedAt = if ($processId) { $processes[0].CreationDate } else { $null }
        WebPortOwners = $webOwners -join ','
        RuntimePortOwners = $runtimeOwners -join ','
        Health = $healthStatus
        RecoveryIssueCount = $recoveryIssueCount
        AnonymousWebStatus = $anonymousWebStatus
        AccessUrl = $accessUrl
    }
}

function Assert-StartPrerequisites {
    if (-not (Test-Path -LiteralPath $startScript)) { throw "找不到启动脚本：$startScript" }
    if (-not (Test-Path -LiteralPath $dshEntry)) { throw "找不到已安装的 DSH 入口：$dshEntry" }
    if (-not (Test-Path -LiteralPath $nodeExe)) { throw "找不到 Node.js 24：$nodeExe" }
    if (-not (Test-Path -LiteralPath $checker)) { throw "找不到控制账检查器：$checker" }
    $task = Get-ScheduledTask -TaskName 'DSH Web Local' -ErrorAction Stop
    if (-not ($task.Actions.Arguments -like "*$startScript*")) {
        throw "计划任务未指向预期的启动脚本：$startScript"
    }
}

function Wait-WebReady([int]$oldProcessId = 0) {
    $deadline = (Get-Date).AddSeconds(240)
    $waiting = [Diagnostics.Stopwatch]::StartNew()
    $nextProgress = 10
    $lastPorts = ''
    do {
        $ports = @(Get-WebListeners)
        $portKey = ($ports | Sort-Object) -join ','
        if ($portKey -and $portKey -ne $lastPorts) {
            $current = Get-WebState
            if ($current.ProcessCount -gt 1 -or
                ($current.WebPortOwners -and $current.WebPortOwners -ne [string]$current.ProcessId) -or
                ($current.RuntimePortOwners -and $current.RuntimePortOwners -ne [string]$current.ProcessId)) {
                throw '启动时检测到重复实例或其他进程占用端口'
            }
            if ($current.State -eq $readyState -and $current.ProcessId -ne $oldProcessId) { return $current }
        } elseif (3080 -in $ports -and 18998 -in $ports) {
            $healthy = $false
            try {
                $health = Invoke-RestMethod -Uri 'http://127.0.0.1:18998/health' -NoProxy -TimeoutSec 3
                $web = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/' -NoProxy -SkipHttpErrorCheck -TimeoutSec 3
                $healthy = $health.status -eq 'ok' -and $null -ne $health.recoveryIssueCount -and
                    [int]$health.recoveryIssueCount -eq 0 -and $web.StatusCode -eq 401
            } catch { }
            if ($healthy) {
                $current = Get-WebState
                if ($current.State -eq $readyState -and $current.ProcessId -ne $oldProcessId) { return $current }
                throw '就绪端口与新进程身份不一致；不得恢复派发'
            }
        }
        $lastPorts = $portKey
        if ($waiting.Elapsed.TotalSeconds -ge $nextProgress) {
            Write-Host ('等待服务初始化：{0:N0} 秒；监听端口：{1}' -f $waiting.Elapsed.TotalSeconds, $(if ($portKey) { $portKey } else { '尚未监听' }))
            $nextProgress += 10
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw '新实例在 240 秒内未就绪；不得重复启动，请检查日志和维护状态'
}

function Invoke-Maintenance($state, [string]$operation, [string]$maintenanceId) {
    $body = @{
        requestId = [guid]::NewGuid().ToString()
        expectedRevision = $state.revision
        maintenanceId = $maintenanceId
        reason = "本地 DSH Web 安全重启：$operation"
    }
    if ($operation -eq 'enter') { $body.active = $true }
    elseif ($operation -eq 'cancel') { $body.active = $false }
    elseif ($operation -notin @('seal', 'resume')) { throw '未知维护操作' }
    $uri = if ($operation -in @('enter', 'cancel')) { $maintenanceUri } else { "$maintenanceUri/$operation" }
    Invoke-RestMethod -Uri $uri -Method Post -ContentType 'application/json' `
        -Headers @{ Origin = 'http://127.0.0.1:3080' } -Body ($body | ConvertTo-Json -Compress) -NoProxy -TimeoutSec 20
}

function Invoke-ControlChecker([string]$mode) {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $nodeExe
    $startInfo.ArgumentList.Add($checker)
    $startInfo.ArgumentList.Add($mode)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $stdout.GetAwaiter().GetResult().TrimEnd([char[]]"`r`n"); Error = $stderr.GetAwaiter().GetResult().TrimEnd([char[]]"`r`n") }
    } finally { $process.Dispose() }
}

function Wait-DrainedSnapshot {
    $deadline = (Get-Date).AddSeconds(60)
    do {
        $checked = Invoke-ControlChecker 'snapshot'
        if ($checked.ExitCode -eq 0) { return $checked.Output }
        $result = $checked.Error
        if ($result -notmatch '^DEPLOY_NOT_DRAINED:nodes=\d+,owners=\d+,effects=\d+,messages=\d+\s*$') {
            throw "控制账检查失败：$result"
        }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
    throw '60 秒内未排空；旧实例保持运行'
}

function Assert-StoppedMaintenanceInactive {
    $checked = Invoke-ControlChecker 'maintenance'
    if ($checked.ExitCode -ne 0) { throw "无法读取停机维护状态：$($checked.Error)" }
    $maintenance = $checked.Output | ConvertFrom-Json
    if ($maintenance.active -isnot [bool]) { throw '停机维护状态缺少有效的 active 布尔字段；不得启动' }
    if ($maintenance.active) { throw '停机实例仍处于维护模式；请按原部署或重启记录接续，不得直接启动' }
}

Write-Host '检查当前实例及重启条件…'
$status = Get-WebState
$timings.InitialCheckSeconds = [math]::Round($phaseClock.Elapsed.TotalSeconds, 2)
$action = '只读检查；未启停服务'
$evidenceDirectory = $null
if ($Check) {
    Assert-StartPrerequisites
    if ($status.State -eq $readyState) {
        $preflightMaintenance = Invoke-RestMethod -Uri $maintenanceUri -NoProxy -TimeoutSec 10
        if ($preflightMaintenance.active -or
            $preflightMaintenance.processIncarnation -notmatch ('^' + $status.ProcessId + ':')) {
            throw '已有维护操作或运行实例身份不匹配；重启预检失败'
        }
        [void](Wait-DrainedSnapshot)
    } elseif ($status.State -eq '已停止') {
        Assert-StoppedMaintenanceInactive
    } else {
        throw '现有进程或端口状态不一致；重启预检失败'
    }
} else {
    Assert-StartPrerequisites
    if (-not (Test-Path -LiteralPath $logDirectory)) {
        New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    }
    if ($status.State -eq '已停止') {
        Assert-StoppedMaintenanceInactive
        Write-Host '启动新实例…'
        $phaseClock.Restart()
        Start-ScheduledTask -TaskName 'DSH Web Local'
        $status = Wait-WebReady
        $timings.ServiceReadySeconds = [math]::Round($phaseClock.Elapsed.TotalSeconds, 2)
        $action = '已启动；此前无运行实例'
    } elseif ($status.State -eq $readyState) {
        $oldProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($status.ProcessId)"
        if (-not $oldProcess -or $oldProcess.CreationDate -ne $status.ProcessStartedAt) {
            throw '旧进程身份已变化，未执行重启'
        }
        $before = Invoke-RestMethod -Uri $maintenanceUri -NoProxy -TimeoutSec 10
        if ($before.active -or $before.processIncarnation -notmatch ('^' + $status.ProcessId + ':')) {
            throw '已有维护操作或运行实例身份不匹配，未执行重启'
        }
        $maintenanceId = 'restart-' + [guid]::NewGuid().ToString()
        $evidenceDirectory = Join-Path $logDirectory $maintenanceId
        New-Item -ItemType Directory -Path $evidenceDirectory | Out-Null
        $entered = $null
        $sealed = $false
        try {
            Write-Host '排空并封存旧实例…'
            $phaseClock.Restart()
            $entered = Invoke-Maintenance $before 'enter' $maintenanceId
            if (-not $entered.state.active -or $entered.state.maintenanceId -ne $maintenanceId) {
                throw '进入维护后的许可回读不匹配'
            }
            $entered | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $evidenceDirectory 'maintenance-entered.json') -Encoding utf8
            [void](Wait-DrainedSnapshot)
            $sealResult = Invoke-Maintenance $entered.state 'seal' $maintenanceId
            $sealed = $true
            if (-not $sealResult.state.stopPermitted -or $sealResult.state.maintenanceId -ne $maintenanceId -or
                $sealResult.state.processIncarnation -ne $before.processIncarnation) {
                throw '未取得绑定旧进程的停机许可'
            }
            $sealResult | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $evidenceDirectory 'maintenance-sealed.json') -Encoding utf8
            $snapshot = Wait-DrainedSnapshot
            $snapshotPath = Join-Path $evidenceDirectory 'control-before.json'
            $snapshot | Set-Content -LiteralPath $snapshotPath -Encoding utf8
            $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($status.ProcessId)"
            $permit = Invoke-RestMethod -Uri $maintenanceUri -NoProxy -TimeoutSec 10
            if (-not $current -or $current.CreationDate -ne $oldProcess.CreationDate -or
                -not $permit.stopPermitted -or $permit.maintenanceId -ne $maintenanceId -or
                $permit.revision -ne $sealResult.state.revision -or
                $permit.processIncarnation -ne $before.processIncarnation -or
                (Wait-DrainedSnapshot) -ne $snapshot) {
                throw '停机前进程、许可或控制快照发生变化'
            }
            $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($oldProcess.ProcessId) AND Name='dws.exe'")
            $timings.DrainAndSealSeconds = [math]::Round($phaseClock.Elapsed.TotalSeconds, 2)
            $phaseClock.Restart()
            Stop-Process -Id $oldProcess.ProcessId -Force
            foreach ($child in $children) {
                $stillThere = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.ProcessId)"
                if ($stillThere -and $stillThere.CreationDate -eq $child.CreationDate) {
                    Stop-Process -Id $child.ProcessId -Force
                }
            }
            $stopDeadline = (Get-Date).AddSeconds(15)
            do {
                if (@(Get-WebListeners).Count -eq 0) {
                    $stopped = Get-WebState
                    if ($stopped.State -eq '已停止') { break }
                }
                Start-Sleep -Milliseconds 250
            } while ((Get-Date) -lt $stopDeadline)
            if ($stopped.State -ne '已停止') { throw '旧实例未完全退出；未启动第二实例' }
            $timings.StopSeconds = [math]::Round($phaseClock.Elapsed.TotalSeconds, 2)
            Write-Host '启动新实例…'
            $phaseClock.Restart()
            Start-ScheduledTask -TaskName 'DSH Web Local'
            $status = Wait-WebReady $oldProcess.ProcessId
            $timings.ServiceReadySeconds = [math]::Round($phaseClock.Elapsed.TotalSeconds, 2)
            $phaseClock.Restart()
            $newMaintenance = Invoke-RestMethod -Uri $maintenanceUri -NoProxy -TimeoutSec 10
            if ($newMaintenance.maintenanceId -ne $maintenanceId -or -not $newMaintenance.resumePermitted -or
                $newMaintenance.processIncarnation -notmatch ('^' + $status.ProcessId + ':')) {
                throw '新实例维护许可或进程身份不匹配；保持维护模式'
            }
            & $nodeExe $checker verify $snapshotPath | Out-Null
            if ($LASTEXITCODE -ne 0) { throw '旧任务和历史回读失败；保持维护模式' }
            $resumed = Invoke-Maintenance $newMaintenance 'resume' $maintenanceId
            $resumeReadback = Invoke-RestMethod -Uri $maintenanceUri -NoProxy -TimeoutSec 10
            if ($resumed.state.active -or $resumed.state.maintenanceId -ne $maintenanceId -or
                $resumeReadback.active -or $resumeReadback.maintenanceId -ne $maintenanceId -or
                $resumeReadback.revision -ne $resumed.state.revision) {
                throw '恢复派发回读失败'
            }
            $resumed | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $evidenceDirectory 'maintenance-resumed.json') -Encoding utf8
            $action = '已安全重启并恢复派发'
            $timings.VerifyAndResumeSeconds = [math]::Round($phaseClock.Elapsed.TotalSeconds, 2)
        }
        catch {
            $failure = $_.Exception.Message
            if ($entered -and -not $sealed) {
                try {
                    $currentMaintenance = Invoke-RestMethod -Uri $maintenanceUri -NoProxy -TimeoutSec 10
                    if ($currentMaintenance.active -and $currentMaintenance.phase -eq 'draining' -and
                        $currentMaintenance.maintenanceId -eq $maintenanceId) {
                        [void](Invoke-Maintenance $currentMaintenance 'cancel' $maintenanceId)
                    }
                } catch { $failure += "；取消维护也失败：$($_.Exception.Message)" }
            }
            throw "安全重启未完成：$failure。证据目录：$evidenceDirectory；请先检查维护状态，不要重复运行。"
        }
    } else {
        throw '现有进程或端口状态不一致，未执行重启'
    }
}

$status = Get-WebState -IncludeAccessUrl
$timings.TotalSeconds = [math]::Round($restartClock.Elapsed.TotalSeconds, 2)
[pscustomobject]@{
    Action = $action
    State = $status.State
    ProcessId = $status.ProcessId
    WebPortOwners = $status.WebPortOwners
    RuntimePortOwners = $status.RuntimePortOwners
    Health = $status.Health
    RecoveryIssueCount = $status.RecoveryIssueCount
    AnonymousWebStatus = $status.AnonymousWebStatus
    AccessUrl = if ($status.AccessUrl) { $status.AccessUrl } else { '未找到当前进程的登录链接' }
    DshHome = $dshHome
    EvidenceDirectory = $evidenceDirectory
    DeploymentRunbook = $runbook
    TimingSeconds = [pscustomobject]$timings
} | Format-List

if (-not $Check -and $status.State -ne $readyState) {
    throw "DSH Web 未就绪；请按部署规程检查当前进程和启动日志：$runbook"
}
