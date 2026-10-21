# 只在 loopback 启动临时 HTTP fixture，验证公共健康脚本的 JSON / 退出码调用合同。
[CmdletBinding()]
param([string]$HealthScript = 'D:\baibu-agent\scripts\read-uat-health.ps1')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$HealthScript = (Resolve-Path -LiteralPath $HealthScript).Path
$pwsh = Join-Path $PSHOME 'pwsh.exe'
$results = [Collections.Generic.List[object]]::new()

function Assert-Contract([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "contract_assertion_failed: $Message" }
}

# 先取得空闲 loopback 端口；fixture 仅接受本机请求，不接触 UAT 或业务数据。
$portProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$portProbe.Start()
$fixturePort = $portProbe.LocalEndpoint.Port
$portProbe.Stop()
$baseUri = "http://127.0.0.1:$fixturePort"
$fixture = Start-ThreadJob -ArgumentList $baseUri -ScriptBlock {
    param($BaseUri)
    $ErrorActionPreference = 'Stop'
    $listener = [Net.HttpListener]::new()
    $listener.Prefixes.Add("$BaseUri/")
    $pathCounts = @{}
    try {
        $listener.Start()
        'fixture_ready'
        while ($listener.IsListening) {
            $context = $listener.GetContext()
            $path = $context.Request.Url.AbsolutePath
            $pathCounts[$path] = 1 + [int]$pathCounts[$path]
            $status = 200
            $contentType = 'application/json'
            $body = '{"status":"UP","fixture":"do-not-emit-fixture-body"}'
            switch ($path) {
                '/health-json' { $contentType = 'application/health+json' }
                '/down' { $body = '{"status":"DOWN"}' }
                '/unavailable' { $status = 503; $body = '{"status":"DOWN"}' }
                '/html' { $contentType = 'text/html'; $body = '<html>do-not-emit-fixture-body</html>' }
                '/invalid-json' { $body = '{do-not-emit-fixture-body' }
                '/redirect' { $status = 302; $context.Response.Headers['Location'] = "$BaseUri/up" }
                '/array' { $body = '[{"status":"UP"}]' }
                '/boolean-status' { $body = '{"status":true}' }
                '/lowercase' { $body = '{"status":"up"}' }
                '/retry-in-process' { if ($pathCounts[$path] -eq 1) { $status = 503 } }
                '/retry-independent' { if ($pathCounts[$path] -eq 1) { $status = 503 } }
            }
            $context.Response.StatusCode = $status
            $context.Response.ContentType = $contentType
            $bytes = [Text.Encoding]::UTF8.GetBytes($body)
            $context.Response.ContentLength64 = $bytes.Length
            $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
            $context.Response.Close()
            if ($path -eq '/__stop') { break }
        }
    } finally {
        $listener.Close()
    }
}

function Test-HealthCase {
    param(
        [string]$Name,
        [string[]]$Paths,
        [bool]$Healthy,
        [int]$Attempts = 1,
        [int]$AttemptsUsed = 1,
        [switch]$Independent,
        [switch]$UninitializedExitCode
    )
    $uris = @($Paths | ForEach-Object { "$baseUri$_" })
    if ($Independent) {
        # -File 对数组参数的命令行绑定有限；独立进程验证单入口，同进程覆盖多入口。
        Assert-Contract ($uris.Count -eq 1) "$Name independent fixture must be a single endpoint"
        $raw = & $pwsh -NoProfile -File $HealthScript -Uri $uris[0] `
            -Attempts $Attempts -IntervalSeconds 0 -TimeoutSeconds 2
        $code = $LASTEXITCODE
    } else {
        if ($UninitializedExitCode) {
            Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
            Assert-Contract ($null -eq (Get-Variable LASTEXITCODE -ErrorAction SilentlyContinue)) 'first call must start without LASTEXITCODE'
        } else {
            & $pwsh -NoProfile -Command 'exit 17'
            Assert-Contract ($LASTEXITCODE -eq 17) 'native exit-code precondition'
        }
        $raw = & $HealthScript -Uri $uris -Attempts $Attempts -IntervalSeconds 0 -TimeoutSeconds 2 -ErrorAction Stop
        $code = $LASTEXITCODE
    }
    # 此处可运行本身证明 & 调用中的 exit 不会终止调用者；失败仍须留下可解析的 JSON。
    $result = ($raw -join "`n") | ConvertFrom-Json -ErrorAction Stop
    $expectedCode = if ($Healthy) { 0 } else { 1 }
    Assert-Contract ($code -eq $expectedCode) "$Name exit=$code expected=$expectedCode"
    Assert-Contract ($result.healthy -is [bool] -and $result.healthy -eq $Healthy) "$Name JSON healthy"
    Assert-Contract ($result.attemptsUsed -eq $AttemptsUsed) "$Name bounded retries"
    Assert-Contract (@($result.history[-1].endpoints).Count -eq $uris.Count) "$Name endpoint coverage"
    Assert-Contract (($raw -join "`n") -notmatch 'do-not-emit-fixture-body') "$Name response body must remain private"
    Assert-Contract ($result.scope -match 'verify runtime image identity separately') "$Name proof boundary"
    $results.Add([ordered]@{
        case = $Name; mode = $(if ($Independent) { 'pwsh -File' } else { '& same process' })
        exitCode = $code; healthy = $result.healthy; attempts = $result.attemptsUsed; callerContinued = $true; pass = $true
    })
}

try {
    $ready = $false
    for ($i = 0; $i -lt 100; $i++) {
        if (@(Receive-Job -Job $fixture -Keep) -contains 'fixture_ready') { $ready = $true; break }
        if ($fixture.State -eq 'Failed') { throw 'fixture_start_failed' }
        Start-Sleep -Milliseconds 50
    }
    Assert-Contract $ready 'fixture startup'
    Test-HealthCase -Name 'uninitialized-success' -Paths '/up' -Healthy $true -UninitializedExitCode
    Test-HealthCase -Name 'native17-success-two-endpoints' -Paths @('/up', '/health-json') -Healthy $true
    Test-HealthCase -Name 'one-unhealthy-endpoint' -Paths @('/up', '/down') -Healthy $false
    $cases = @(
        @{ name = 'up'; path = '/up'; healthy = $true },
        @{ name = 'health-json'; path = '/health-json'; healthy = $true },
        @{ name = 'down'; path = '/down'; healthy = $false },
        @{ name = 'http503'; path = '/unavailable'; healthy = $false },
        @{ name = 'html200'; path = '/html'; healthy = $false },
        @{ name = 'invalid-json'; path = '/invalid-json'; healthy = $false },
        @{ name = 'redirect'; path = '/redirect'; healthy = $false },
        @{ name = 'array'; path = '/array'; healthy = $false },
        @{ name = 'boolean-status'; path = '/boolean-status'; healthy = $false },
        @{ name = 'lowercase-status'; path = '/lowercase'; healthy = $false }
    )
    foreach ($case in $cases) {
        Test-HealthCase -Name "native17-$($case.name)" -Paths $case.path -Healthy $case.healthy
        Test-HealthCase -Name "independent-$($case.name)" -Paths $case.path -Healthy $case.healthy -Independent
    }
    Test-HealthCase -Name 'bounded-retry-success' -Paths '/retry-in-process' -Healthy $true -Attempts 3 -AttemptsUsed 2
    Test-HealthCase -Name 'bounded-retry-success-independent' -Paths '/retry-independent' -Healthy $true -Attempts 3 -AttemptsUsed 2 -Independent
    Test-HealthCase -Name 'bounded-retry-exhausted' -Paths '/unavailable' -Healthy $false -Attempts 3 -AttemptsUsed 3
    Test-HealthCase -Name 'bounded-retry-exhausted-independent' -Paths '/unavailable' -Healthy $false -Attempts 3 -AttemptsUsed 3 -Independent

    # 不合法的远端 HTTP 在发请求前抛错，不能沿用此前健康成功；不真正访问此地址。
    $invalidUriThrew = $false
    try {
        & $HealthScript -Uri 'http://invalid.example/health' -Attempts 1 -ErrorAction Stop | Out-Null
    } catch {
        $invalidUriThrew = $_.Exception.Message -match 'health_uri_requires_https'
    }
    Assert-Contract $invalidUriThrew 'invalid URI must throw before any request'
    $results.Add([ordered]@{ case = 'invalid-uri'; mode = '& same process'; threw = $true; pass = $true })
    $invalidParameterThrew = $false
    try {
        & $HealthScript -Uri "$baseUri/up" -Attempts 0 -ErrorAction Stop | Out-Null
    } catch {
        $invalidParameterThrew = $_ -is [Management.Automation.ErrorRecord]
    }
    Assert-Contract $invalidParameterThrew 'invalid parameter must throw'
    $results.Add([ordered]@{ case = 'invalid-parameter'; mode = '& same process'; threw = $true; pass = $true })
    $nativeInvalidUri = & $pwsh -NoProfile -File $HealthScript -Uri 'http://invalid.example/health' -Attempts 1 2>&1
    $nativeInvalidUriCode = $LASTEXITCODE
    Assert-Contract ($nativeInvalidUriCode -ne 0 -and ($nativeInvalidUri -join "`n") -match 'health_uri_requires_https') 'independent invalid URI must fail'
    $results.Add([ordered]@{ case = 'invalid-uri-independent'; mode = 'pwsh -File'; exitCode = $nativeInvalidUriCode; pass = $true })
    $null = & $pwsh -NoProfile -File $HealthScript -Uri "$baseUri/up" -Attempts 0 2>&1
    $nativeInvalidParameterCode = $LASTEXITCODE
    Assert-Contract ($nativeInvalidParameterCode -ne 0) 'independent invalid parameter must fail'
    $results.Add([ordered]@{ case = 'invalid-parameter-independent'; mode = 'pwsh -File'; exitCode = $nativeInvalidParameterCode; pass = $true })
    [ordered]@{ pass = $true; count = $results.Count; scope = 'loopback fixtures only; no UAT or business requests'; cases = $results.ToArray() } | ConvertTo-Json -Depth 6
} finally {
    if ($fixture.State -eq 'Running') {
        try { Invoke-WebRequest -Uri "$baseUri/__stop" -TimeoutSec 2 -NoProxy | Out-Null } catch { }
    }
    $null = Wait-Job -Job $fixture -Timeout 3
    if ($fixture.State -eq 'Running') { Stop-Job -Job $fixture }
    Remove-Job -Job $fixture -Force
}
