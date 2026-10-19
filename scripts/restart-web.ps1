param(
    [switch]$Check,
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = 'Stop'
# 本机身份与任务会话原生部署脚本一致，不访问已退役的 workflow 库。
$dshHome = 'D:/dsh_home'
$workspace = 'D:/baibu-agent'
$db = Join-Path $workspace '.dsh/task-sessions.sqlite'
$entry = Join-Path $dshHome 'profiles/web/node_modules/@deepseek-ai/dsh/lib/bin.js'
$node = 'D:/soft/node-v24.19.0/node.exe'
$starter = Join-Path $dshHome 'launchers/start-web.ps1'
$helpers = Join-Path $ProjectRoot 'docs/acceptance/task-session-runtime-repair/scripts'
$ledger = Join-Path $PSScriptRoot 'inspect-quiescent-ledger.mjs'
$signaler = Join-Path $helpers 'stop-web-console.ps1'
$taskName = 'DSH Web Local'
function Owners([int]$Port) {
    @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
}
function Descendants([int]$Parent) {
    foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$Parent")) {
        $child
        Descendants $child.ProcessId
    }
}
function Instances {
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains($entry.Replace('/', '\'), [StringComparison]::OrdinalIgnoreCase) -and
        $_.CommandLine -match ' web --no-open(?:\s|$)'
    })
}
function Run([string]$Executable, [string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($Executable)
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($info)
    try {
        $output = $process.StandardOutput.ReadToEndAsync(); $errors = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        if ($process.ExitCode) { throw $errors.GetAwaiter().GetResult() }
        $output.GetAwaiter().GetResult() | ConvertFrom-Json
    } finally { $process.Dispose() }
}
function LedgerProof { Run $node @($ledger, $db, $workspace) }
function ConsoleSignal([int]$Target, [switch]$CheckOnly) {
    $arguments = @('-NoProfile', '-File', $signaler, '-ExpectedPid', [string]$Target)
    if ($CheckOnly) { $arguments += '-Check' }
    Run (Join-Path $PSHOME 'pwsh.exe') $arguments
}
foreach ($file in @($node, $entry, $starter, $ledger, $signaler, $db)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "缺少启动依赖：$file" }
}
$task = Get-ScheduledTask -TaskName $taskName
$expectedStarter = $starter.Replace('/', '\')
if (@($task.Actions).Count -ne 1 -or $task.Actions.Arguments -notlike "*$expectedStarter*") { throw '计划任务启动入口不匹配' }
if (-not $task.Settings.Enabled -or $task.Settings.RestartCount -ne 0) { throw '计划任务须启用且关闭自动失败重启' }
$instances = @(Instances)
$web = @(Owners 3080); $runtime = @(Owners 18998)
if ($instances.Count -gt 1) { throw '检测到多个 Web 实例，未执行启停' }
$original = if ($instances.Count) { $instances[0] } else { $null }
if ($original) {
    if ($web.Count -ne 1 -or $runtime.Count -ne 1 -or $web[0] -ne $original.ProcessId -or $runtime[0] -ne $original.ProcessId) { throw '进程与端口身份不一致' }
} elseif ($web.Count -or $runtime.Count) { throw '端口被其他进程占用' }
Write-Host '检查任务会话账本及原生回合…'
$proof = if ($original) { LedgerProof } else { Run $node @($ledger, 'startup', $db) }
if ($original -and -not $proof.drained) { throw '任务存在尚未启动的领取，拒绝停机' }
if (-not $original -and -not $proof.ownerProcessExited) { throw '任务账本仍有存活 owner，拒绝启动' }
if ($original) { $null = ConsoleSignal $original.ProcessId -CheckOnly }
if ($Check) {
    [pscustomobject]@{ CheckOnly = $true; Writes = 0; Signals = 0; State = $(if ($original) { '运行中' } else { '已停止' }); ProcessId = $original.ProcessId; Ledger = $proof }
    return
}
$lockPath = Join-Path $ProjectRoot 'docs/tmp/task-session-deployment.lock'
[IO.Directory]::CreateDirectory((Split-Path -Parent $lockPath)) | Out-Null
$restartLock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    if ($original) {
        $children = @(Descendants $original.ProcessId)
        Disable-ScheduledTask -TaskName $taskName | Out-Null
        # 信号发送失败或排空失败时保留停机现场，禁止强杀与自动重启。
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($original.ProcessId)"
        if (-not $current -or $current.CreationDate -ne $original.CreationDate) { throw '旧进程身份已变化' }
        $null = ConsoleSignal $original.ProcessId
        $deadline = [DateTime]::UtcNow.AddSeconds(120)
        do {
            $remainingChildren = @($children | Where-Object {
                $currentChild = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ProcessId)"
                $currentChild -and $currentChild.CreationDate -eq $_.CreationDate
            })
            $oldAlive = $null -ne (Get-Process -Id $original.ProcessId -ErrorAction SilentlyContinue)
            if (-not $oldAlive -and $remainingChildren.Count -eq 0) { break }
            if ([DateTime]::UtcNow -ge $deadline) { throw '原生退出或子进程排空未完成；保留自启禁用状态，请检查原进程' }
            Start-Sleep -Milliseconds 500
        } while ($true)
        if ((Owners 3080).Count -or (Owners 18998).Count) { throw '原生退出后端口仍被占用' }
        $null = Run $node @($ledger, 'startup', $db)
        Enable-ScheduledTask -TaskName $taskName | Out-Null
    }
    if ((Instances).Count -or (Owners 3080).Count -or (Owners 18998).Count) { throw '启动前实例状态已变化，未重复启动' }
    Write-Host '启动 DSH Web，等待双端口和健康状态（最多五分钟）…'
    Start-ScheduledTask -TaskName $taskName
    $deadline = [DateTime]::UtcNow.AddSeconds(300)
    $nextProgress = [DateTime]::UtcNow.AddSeconds(15)
    do {
        $web = @(Owners 3080); $runtime = @(Owners 18998)
        if ($web.Count -eq 1 -and $runtime.Count -eq 1 -and $web[0] -eq $runtime[0]) {
            $instances = @(Instances)
            if ($instances.Count -ne 1 -or $instances[0].ProcessId -ne $web[0]) { throw '新实例端口与进程不匹配' }
            try {
                $health = Invoke-RestMethod http://127.0.0.1:18998/health -NoProxy -TimeoutSec 3
                $anonymous = (Invoke-WebRequest http://127.0.0.1:3080/ -NoProxy -SkipHttpErrorCheck -TimeoutSec 3).StatusCode
                if ($health.status -in @('ok', 'degraded') -and $null -ne $health.recoveryIssueCount -and $anonymous -eq 401 -and
                    (-not $health.inboundConfigured -or $health.inboundProcessing)) {
                    if ($health.status -eq 'degraded') { Write-Warning 'DSH Web 已启动，但健康降级；请查看 /state/recovery-issues，勿通过重复重启或重发通知消除问题。' }
                    [pscustomobject]@{ Action = $(if ($original) { '已原生重启' } else { '已启动' }); ProcessId = $web[0]; Health = $health.status; RecoveryIssueCount = $health.recoveryIssueCount; AnonymousWebStatus = $anonymous }
                    return
                }
            } catch { Write-Verbose $_ }
        }
        if ([DateTime]::UtcNow -ge $nextProgress) { Write-Host '仍在等待初始化；未启动第二实例。'; $nextProgress = [DateTime]::UtcNow.AddSeconds(15) }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw '五分钟内未健康就绪；保留现场，请检查原新进程和日志，勿重复启动'


} finally {
    $restartLock.Dispose()
    Remove-Item -LiteralPath $lockPath
}
